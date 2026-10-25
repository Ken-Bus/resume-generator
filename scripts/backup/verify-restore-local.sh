#!/usr/bin/env bash
# Flex & Grace Resume Generator: prove a backup really restores, on a LOCAL PostgreSQL only (never Supabase).
#
# Usage:  scripts/backup/verify-restore-local.sh <resume-backup-....tar.enc | unencrypted backup folder>
# It decrypts to a private temp folder, checks the checksums, restores twice into scratch databases
#   (A) pg_restore of the custom archive, (B) the official-style psql path: schema.sql + data.sql with triggers off,
# runs docs/BACKUP_BASELINE.sql on each restored copy and compares every MUST line with baseline_before.txt taken from production at the snapshot instant.
# PASS means: same row counts, same fingerprints, same migration status, same permissions, same function bodies.
# Then it deletes the scratch databases and the temp folder (also on failure, Ctrl-C and kill).
# For a .tar.enc it writes the outcome to <backup>.summary/verification.txt: RESULT: PASS only after a full pass, otherwise RESULT: FAIL with the reason.
#
# Needs a LOCAL PostgreSQL server whose major version is the same as, or newer than, the Supabase server, and permission to create databases/roles
# (e.g. the default postgres user). Connection comes from PGHOST/PGPORT/PGUSER/PGPASSWORD (default: local socket). Remote hosts are refused.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASELINE_SQL="${HERE}/../../docs/BACKUP_BASELINE.sql"
SRC="${1:-}"
WORK=""; SCRATCH_A=""; SCRATCH_B=""; FINAL="FAIL"; REASON="stopped before finishing"; SUMMARY_DIR=""; ENC_SUM=""; LOCAL_VER=""

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
write_marker() {
  [ -n "$SUMMARY_DIR" ] && [ -d "$SUMMARY_DIR" ] || return 0
  { echo "RESULT: ${FINAL}"; echo "reason: ${REASON}"; echo "checked_utc: $(date -u +%Y%m%dT%H%M%SZ)"; echo "encrypted_file_sha256: ${ENC_SUM:-unknown}"; echo "local_postgres: ${LOCAL_VER:-unknown}"
    [ "$FINAL" = PASS ] || echo "Do NOT rely on this backup. Make a new one and verify it again before any migration."; } > "${SUMMARY_DIR}/verification.txt" 2>/dev/null || true
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "$FINAL" != PASS ] && [ "$rc" -eq 0 ]; then rc=1; fi
  if [ "${RG_KEEP_SCRATCH:-0}" != "1" ]; then
    [ -n "$SCRATCH_A" ] && dropdb --if-exists --force "$SCRATCH_A" >/dev/null 2>&1 || true
    [ -n "$SCRATCH_B" ] && dropdb --if-exists --force "$SCRATCH_B" >/dev/null 2>&1 || true
  fi
  [ -n "$WORK" ] && [ -d "$WORK" ] && rm -rf "$WORK"
  write_marker
  if [ "$FINAL" != PASS ]; then printf 'RESULT: FAIL (%s). Do not rely on this backup. Do not proceed to any migration. No decrypted files were left behind.\n' "$REASON" >&2; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'REASON="interrupted"; exit 130' INT
trap 'REASON="terminated"; exit 143' TERM
trap 'REASON="hang-up"; exit 129' HUP
die() { REASON="$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed or not on PATH."; }

for t in psql pg_restore createdb dropdb openssl tar awk; do need "$t"; done
[ -n "$SRC" ] || die "give the .tar.enc file or the backup folder as the first argument."
case "$SRC" in *.tar.enc) SUMMARY_DIR="${SRC%.tar.enc}.summary"; [ -f "$SRC" ] && ENC_SUM="$(sha256 "$SRC" | cut -d' ' -f1)";; esac

export PGHOST="${PGHOST:-}"
case "${PGHOST:-}" in ""|/*|localhost|127.*|::1) ;; *) die "PGHOST='${PGHOST}' is not local. This script only restores into a local PostgreSQL; it refuses remote servers (Supabase included).";; esac
export PGDATABASE="${PGDATABASE:-postgres}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -A -t -c "select 1" >/dev/null 2>&1 || die "cannot connect to the local PostgreSQL (set PGHOST/PGPORT/PGUSER)."
LOCAL_VER="$("${PSQL[@]}" -A -t -c "show server_version")"
LOCAL_MAJOR=$(( $("${PSQL[@]}" -A -t -c "show server_version_num") / 10000 ))

# all decrypted material lives in ONE private folder that the trap removes on every exit path
TMPBASE="${RG_TMPDIR:-${TMPDIR:-/tmp}}"; mkdir -p "$TMPBASE"
WORK="$(mktemp -d "${TMPBASE%/}/rg-verify.XXXXXX")"; chmod 700 "$WORK"
SCRATCH_A="rg_restore_a_$$"; SCRATCH_B="rg_restore_b_$$"

# ---- unpack ----
if [ -d "$SRC" ]; then B="$SRC"
else
  [ -f "$SRC" ] || die "file not found: $SRC"
  if [ -z "${RG_BACKUP_PASSPHRASE:-}" ]; then [ -t 0 ] || die "no passphrase: set RG_BACKUP_PASSPHRASE or run in a terminal."; read -r -s -p "Backup passphrase (hidden): " RG_BACKUP_PASSPHRASE; printf '\n'; fi
  export RG_BACKUP_PASSPHRASE
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:RG_BACKUP_PASSPHRASE -in "$SRC" 2>/dev/null | tar -C "$WORK" -xf - 2>/dev/null || die "could not decrypt (wrong passphrase or damaged file)."
  B="$(find "$WORK" -maxdepth 1 -type d -name 'resume-backup-*' | head -1)"; [ -n "$B" ] || die "no backup folder inside the archive."
fi
( cd "$B" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS >/dev/null 2>&1; else shasum -a 256 -c SHA256SUMS >/dev/null 2>&1; fi ) || die "checksum mismatch: the backup contents are damaged."
echo "Checksums OK."

SERVER_VER="$(sed -n 's/^server_version: //p' "$B/manifest.txt")"; SERVER_MAJOR="${SERVER_VER%%.*}"; SERVER_MAJOR="${SERVER_MAJOR%% *}"
echo "Backup came from PostgreSQL ${SERVER_VER}; this local server is major ${LOCAL_MAJOR}."
[ "$LOCAL_MAJOR" -ge "$SERVER_MAJOR" ] || die "local PostgreSQL ${LOCAL_MAJOR} is older than the source ${SERVER_MAJOR}; restore would be unreliable. Use a local server ${SERVER_MAJOR} or newer (e.g. docker run postgres:${SERVER_MAJOR})."

# ---- helpers ----
prepare() {  # $1 = scratch database name
  "${PSQL[@]}" -d "$PGDATABASE" -c "
    do \$\$ declare r text; begin
      foreach r in array array['anon','authenticated','service_role','authenticator','supabase_admin','supabase_auth_admin','supabase_storage_admin','dashboard_user','pgbouncer'] loop
        if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
      end loop; end \$\$;"
  createdb "$1"
  "${PSQL[@]}" -d "$1" -c "create schema if not exists extensions;"     # schema public already exists in a new database, as in a new Supabase project
  sed -n 's/^INFO|extensions|//p' "$B/baseline_before.txt" | tr ',' '\n' | sed -E 's/^ *//; s/ [^ ]*$//' | while read -r e; do
    case "$e" in ""|plpgsql) continue;; esac
    "${PSQL[@]}" -d "$1" -c "create extension if not exists \"$e\" with schema extensions" >/dev/null 2>&1 || echo "note: extension $e not available locally (only matters if the app uses it)"
  done
}
compare() {  # $1 = scratch database name, $2 = label
  "${PSQL[@]}" -A -t -F'|' -d "$1" -f "$BASELINE_SQL" | grep -E '^(MUST|INFO)\|' > "$WORK/after_$2.txt"
  grep '^MUST|' "$B/baseline_before.txt" | sort > "$WORK/must_before.txt"
  grep '^MUST|' "$WORK/after_$2.txt" | sort > "$WORK/must_after_$2.txt"
  if diff "$WORK/must_before.txt" "$WORK/must_after_$2.txt" > "$WORK/diff_$2.txt"; then
    echo "PASS (${2}): all $(wc -l < "$WORK/must_before.txt" | tr -d ' ') baseline checks identical after restore."
    return 0
  else
    echo "FAIL (${2}): these baseline lines differ (< before restore, > after restore):"; cat "$WORK/diff_$2.txt"; return 1
  fi
}

OK=1
echo "--- Restore A: pg_restore (custom archive) ---"
prepare "$SCRATCH_A"
pg_restore --list "$B/resume-db.dump" | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public ' > "$WORK/restore.list"
if pg_restore --no-owner --exit-on-error -L "$WORK/restore.list" -d "$SCRATCH_A" "$B/resume-db.dump" 2> "$WORK/restore_a.err"; then echo "pg_restore finished without errors."; else echo "pg_restore reported errors:"; head -20 "$WORK/restore_a.err"; OK=0; fi
compare "$SCRATCH_A" A || OK=0

echo "--- Restore B: psql schema.sql + data.sql (the official Supabase restore shape) ---"
prepare "$SCRATCH_B"
sed '/^CREATE SCHEMA public;$/d' "$B/schema.sql" > "$WORK/schema_restore.sql"
if psql -X -q --single-transaction -v ON_ERROR_STOP=1 -d "$SCRATCH_B" --file "$WORK/schema_restore.sql" --command 'SET session_replication_role = replica' --file "$B/data.sql" > /dev/null 2> "$WORK/restore_b.err"; then echo "psql restore finished without errors."; else echo "psql restore reported errors:"; head -20 "$WORK/restore_b.err"; OK=0; fi
compare "$SCRATCH_B" B || OK=0

echo "---"
if [ "$OK" = 1 ]; then FINAL="PASS"; REASON="both restores match the baseline"; echo "RESULT: PASS. The backup restores completely and matches production's baseline at the snapshot instant."; else die "a restore or a baseline comparison failed (see above)"; fi
