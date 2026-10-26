#!/usr/bin/env bash
# Flex & Grace Resume Generator: READ-ONLY logical backup of the Supabase database (Free plan, no paid service).
#
# What it does (nothing is ever written to the database):
#   1. checks everything that can fail BEFORE any customer data is touched (tools, project, versions, encryption setup, passphrase);
#   2. opens ONE read-only REPEATABLE READ transaction, exports its snapshot, and takes the baseline INSIDE it, so the baseline and the dump
#      describe exactly the same instant (customers charging codes meanwhile cannot make them disagree);
#   3. makes ONE pg_dump of that snapshot (schema.sql and data.sql are derived from that same archive, not dumped separately);
#   4. RECONCILES the archive against the baseline (row counts and generation totals read back out of the archive) and refuses on any mismatch;
#   5. encrypts everything into one AES-256 file, proves it decrypts and passes its checksums, then deletes all plaintext.
# Every plaintext file lives in a private work folder that is removed on success, failure, Ctrl-C, kill (TERM/HUP) or any error.
# LIMIT: SIGKILL (kill -9), a crash of the computer, or power loss cannot run any cleanup. That is why a production run REQUIRES the work folder
# (RG_WORKDIR) to be on an encrypted or RAM-backed volume, and why the next run refuses to start while an abandoned work folder exists.
# There is deliberately NO option to keep a plaintext dump.
# A backup is only USABLE after scripts/backup/verify-restore-local.sh prints RESULT: PASS; this script says so and writes verification.txt accordingly.
#
# Run it from the repository root (or anywhere): scripts/backup/backup-resume-db.sh
# Needs: bash, psql, pg_dump, pg_restore (PostgreSQL client tools, same major version as the server or newer), openssl (with -pbkdf2), tar, awk, sha256sum or shasum.
# Customer data is in the output. Keep the .enc file private. Never commit it, e-mail it, or paste any of it into an AI chat.
set -euo pipefail
umask 077

EXPECTED_REF="${RG_EXPECTED_REF:-mvtgifohlwlyedokiyhb}"          # Flex & Grace Resume Project
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASELINE_SQL="${HERE}/../../docs/BACKUP_BASELINE.sql"
OUT_ROOT="${RG_BACKUP_DIR:-$HOME/resume-generator-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="resume-backup-${STAMP}"
ENC="${OUT_ROOT}/${NAME}.tar.enc"
SUMMARY="${OUT_ROOT}/${NAME}.summary"
FAILNOTE="${OUT_ROOT}/${NAME}.FAILED.txt"

STEP="startup"; WORK=""; HOLD_PID=""; FIFO=""; BG_PID=""; SUCCESS=0; NOTE_OK=0

# ---- cleanup: runs on success, failure, Ctrl-C, TERM and HUP. Plaintext never outlives the script. ----
redact() { sed -E 's/FG-[A-Za-z0-9]{3,4}-[A-Za-z0-9]{4}/FG-REDACTED/g; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/EMAIL-REDACTED/g'; }
stop_holder() {
  exec 3>&- || true                 # (no stderr redirect here: 'exec' would silence the script's own error messages for good)
  if [ -n "${HOLD_PID:-}" ]; then kill "$HOLD_PID" 2>/dev/null || true; wait "$HOLD_PID" 2>/dev/null || true; HOLD_PID=""; fi
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "$SUCCESS" != 1 ] && [ "$rc" -eq 0 ]; then rc=1; fi          # ending early without finishing is always a failure
  if [ -n "${BG_PID:-}" ]; then kill "$BG_PID" 2>/dev/null || true; wait "$BG_PID" 2>/dev/null || true; fi
  stop_holder
  if [ "$SUCCESS" != 1 ] && [ "$NOTE_OK" = 1 ] && [ -d "$OUT_ROOT" ]; then
    # non-sensitive diagnostics only: step, exit code, versions, and the tools' own messages with codes/e-mails masked
    { echo "Backup FAILED. No usable backup was produced. All plaintext working files were deleted."
      echo "failed_step: ${STEP}"; echo "exit_code: ${rc}"; echo "time_utc: $(date -u +%Y%m%dT%H%M%SZ)"
      echo "pg_dump: $(pg_dump --version 2>/dev/null || echo unknown)"; echo "server_version: ${SERVER_VERSION:-unknown}"; echo "snapshot_mode: ${SNAP_MODE:-unknown}"
      for f in pg_dump.err hold.err reconcile.txt; do [ -s "${WORK:-/nonexistent}/$f" ] && { echo "--- $f (masked, last 30 lines) ---"; tail -30 "$WORK/$f" | redact; }; done
    } > "$FAILNOTE" 2>/dev/null || true
  fi
  [ -n "${WORK:-}" ] && [ -d "$WORK" ] && rm -rf "$WORK"
  if [ "$SUCCESS" != 1 ]; then
    rm -f "$ENC" "${ENC}.partial" 2>/dev/null || true; rm -rf "$SUMMARY" 2>/dev/null || true
    if [ "$rc" -ne 0 ]; then
      printf 'FAILED in step "%s" (exit %s). No usable backup was produced and no plaintext was left behind.\n' "$STEP" "$rc" >&2
      [ "$NOTE_OK" = 1 ] && [ -f "$FAILNOTE" ] && printf 'Non-sensitive diagnostics: %s\n' "$FAILNOTE" >&2
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed or not on PATH (see docs/PRODUCTION_BACKUP_RUNBOOK.md, section 3)."; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

STEP="checking tools"
for t in psql pg_dump pg_restore openssl tar awk; do need "$t"; done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || die "neither sha256sum nor shasum is available."
[ -r "$BASELINE_SQL" ] || die "cannot find docs/BACKUP_BASELINE.sql next to this script."

# ---- connection (libpq environment variables; the password is read hidden) ----
STEP="connection settings"
if [ -z "${PGHOST:-}" ]; then read -r -p "Database host (Supabase > Connect > Session pooler, looks like aws-0-xx-xxxx-x.pooler.supabase.com): " PGHOST; fi
export PGHOST
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-postgres}"
export PGUSER="${PGUSER:-postgres.${EXPECTED_REF}}"
if [ -z "${PGPASSWORD:-}" ]; then read -r -s -p "Database password (hidden; not saved anywhere): " PGPASSWORD; printf '\n'; fi
export PGPASSWORD
case "$PGHOST" in
  /*|localhost|127.*|::1) LOCAL=1 ;;
  *) LOCAL=0; export PGSSLMODE="${PGSSLMODE:-require}" ;;
esac
export PGCONNECT_TIMEOUT=15
export PGAPPNAME="${PGAPPNAME:-rg-backup}"

STEP="project guard"
if [ "$LOCAL" = 0 ]; then
  [ "$PGPORT" != "6543" ] || die "port 6543 is the transaction pooler; pg_dump needs the Session pooler (port 5432)."
  case "$PGUSER" in "postgres.${EXPECTED_REF}") ;; *) [ "$PGHOST" = "db.${EXPECTED_REF}.supabase.co" ] || die "this connection is not for project ${EXPECTED_REF} (Flex & Grace Resume Project). Refusing to continue. The user name must be postgres.${EXPECTED_REF}.";; esac
fi

# ---- encrypted temporary workspace (plaintext may only ever exist here) ----
STEP="checking the temporary workspace"
ROOT_REPO="$(cd "${HERE}/../.." && pwd -P)"
if [ -n "${RG_WORKDIR:-}" ]; then WORKBASE="$RG_WORKDIR"
elif [ "$LOCAL" = 1 ]; then WORKBASE="$OUT_ROOT"          # local test databases only
else die "a production backup needs an ENCRYPTED temporary workspace. Set RG_WORKDIR to a folder on an encrypted or RAM-backed volume (docs/PRODUCTION_BACKUP_RUNBOOK.md, section 5a). Nothing was read from the database."
fi
if [ -n "${RG_WORKDIR:-}" ]; then
  [ -d "$WORKBASE" ] && [ -w "$WORKBASE" ] || die "RG_WORKDIR='${WORKBASE}' is not an existing writable folder. Create/mount the encrypted workspace first."
  WORKBASE="$(cd "$WORKBASE" && pwd -P)"
  case "$WORKBASE/" in "${ROOT_REPO}/"*) die "RG_WORKDIR must not be inside the repository (plaintext could be committed).";; esac
  FSTYPE="$(stat -f -c %T "$WORKBASE" 2>/dev/null || true)"
  case "$FSTYPE" in
    tmpfs|ramfs) WORKSPACE_KIND="RAM-backed (${FSTYPE}); vanishes on power loss" ;;
    *)
      if [ "${RG_WORKDIR_CONFIRMED:-}" = "yes" ]; then WORKSPACE_KIND="owner confirmed an encrypted volume (RG_WORKDIR_CONFIRMED=yes)"
      elif [ -t 0 ]; then
        printf 'The script cannot verify disk encryption. Is %s on an ENCRYPTED volume (BitLocker, FileVault, LUKS, or an encrypted disk image) or a RAM disk?\n' "$WORKBASE"
        read -r -p "Type ENCRYPTED to confirm, anything else to stop: " ANSWER
        [ "$ANSWER" = "ENCRYPTED" ] || die "workspace not confirmed as encrypted. Nothing was read from the database."
        WORKSPACE_KIND="owner confirmed an encrypted volume (typed ENCRYPTED)"
      else die "workspace encryption is not confirmed: run in a terminal or set RG_WORKDIR_CONFIRMED=yes once the folder is on an encrypted volume. Nothing was read from the database."
      fi ;;
  esac
else WORKSPACE_KIND="local test database (no workspace requirement)"
fi
# abandoned work folders from a killed or crashed earlier run hold customer data: refuse to start until they are dealt with
ABANDONED=()
for base in "$WORKBASE" "$OUT_ROOT"; do
  [ -d "$base" ] || continue
  while IFS= read -r d; do [ -n "$d" ] && ABANDONED+=("$d"); done < <(find "$base" -maxdepth 1 -type d \( -name 'rg-backup-work.*' -o -name '.work.*' \) 2>/dev/null | sort -u)
done
if [ "${#ABANDONED[@]}" -gt 0 ]; then
  if [ "${RG_DELETE_ABANDONED:-}" = "yes" ]; then
    for d in "${ABANDONED[@]}"; do rm -rf "$d"; printf 'Deleted abandoned work folder: %s\n' "$d"; done
  else
    printf 'STOP: a previous backup run did not finish cleanly (killed, crashed, or power loss) and left %s work folder(s) that may contain UNENCRYPTED customer data:\n' "${#ABANDONED[@]}" >&2
    for d in "${ABANDONED[@]}"; do printf '  %s   (%s KB, last changed %s)\n' "$d" "$(du -sk "$d" 2>/dev/null | cut -f1)" "$(date -r "$d" '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)" >&2; done
    printf 'Do NOT open or copy them. Delete them, then run again:\n  rm -rf' >&2; for d in "${ABANDONED[@]}"; do printf ' %q' "$d" >&2; done
    printf '\n(or rerun with RG_DELETE_ABANDONED=yes; see the runbook, section 5a). No database was contacted.\n' >&2
    exit 1
  fi
fi

# ---- encryption must be certain BEFORE any customer data is read, so nothing is ever dumped and then stranded ----
STEP="encryption setup"
if [ -z "${RG_BACKUP_PASSPHRASE:-}" ]; then
  [ -t 0 ] || die "no encryption passphrase: set RG_BACKUP_PASSPHRASE or run in a terminal. Nothing was read from the database."
  read -r -s -p "Choose an encryption passphrase (hidden; store it in your password manager, NOT next to the backup): " P1; printf '\n'
  read -r -s -p "Type it again: " P2; printf '\n'
  [ "$P1" = "$P2" ] || die "the two passphrases differ. Nothing was read from the database."
  RG_BACKUP_PASSPHRASE="$P1"
fi
[ "${#RG_BACKUP_PASSPHRASE}" -ge 12 ] || die "the passphrase must be at least 12 characters. Nothing was read from the database."
export RG_BACKUP_PASSPHRASE
ENC_ARGS=(-aes-256-cbc -salt -pbkdf2 -iter 600000 -pass env:RG_BACKUP_PASSPHRASE)
[ "$(printf 'rg-selftest' | openssl enc "${ENC_ARGS[@]}" 2>/dev/null | openssl enc -d "${ENC_ARGS[@]}" 2>/dev/null)" = "rg-selftest" ] \
  || die "this openssl cannot do AES-256 with -pbkdf2 (macOS: install Homebrew openssl). Nothing was read from the database."

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
STEP="connecting"
"${PSQL[@]}" -A -t -c "select 1" >/dev/null 2>&1 || die "could not connect. Check host, port 5432, user, password and that the project is not paused."

# ---- safety checks ----
STEP="version and project checks"
SERVER_NUM="$("${PSQL[@]}" -A -t -c "show server_version_num")"; SERVER_MAJOR=$(( SERVER_NUM / 10000 ))
SERVER_VERSION="$("${PSQL[@]}" -A -t -c 'show server_version')"
CLIENT_MAJOR="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
info "Server PostgreSQL major version: ${SERVER_MAJOR}; your pg_dump major version: ${CLIENT_MAJOR}"
[ "$CLIENT_MAJOR" -ge "$SERVER_MAJOR" ] || die "your pg_dump (${CLIENT_MAJOR}) is OLDER than the server (${SERVER_MAJOR}); pg_dump refuses that. Install PostgreSQL client tools ${SERVER_MAJOR} or newer."
HAS="$("${PSQL[@]}" -A -t -c "select to_regclass('public.licenses') is not null")"
[ "$HAS" = "t" ] || die "table public.licenses not found: this is not the Resume project database. Nothing was dumped."

# ---- protected work folder (all plaintext lives here and nowhere else) ----
STEP="creating the private work folder"
mkdir -p "$OUT_ROOT"; chmod 700 "$OUT_ROOT"
NOTE_OK=1
WORK="$(mktemp -d "${WORKBASE}/rg-backup-work.XXXXXX")"; chmod 700 "$WORK"
DIR="${WORK}/${NAME}"; mkdir "$DIR"
info "Private work folder (deleted automatically): ${WORK}"

SCHEMA_SQL="select string_agg(nspname, ' ' order by nspname) from pg_namespace where nspname !~ '^(pg_|information_schema)' and nspname not in ('auth','storage','realtime','vault','extensions','graphql','graphql_public','pgsodium','pgsodium_masks','net','cron','pgbouncer','supabase_functions','_realtime','_analytics','supavisor','pgmq','pgmq_public','topology','tiger','tiger_data','cron_job_run_details') and (nspname = 'public' or exists (select 1 from pg_class c where c.relnamespace = pg_namespace.oid and c.relkind in ('r','p','v','m','S')) or exists (select 1 from pg_proc p where p.pronamespace = pg_namespace.oid))"

# ---- 1. ONE shared snapshot: baseline, schema list and dump all come from the same instant ----
SNAP=""; SNAP_MODE="shared-snapshot"
if [ "${RG_NO_SNAPSHOT:-0}" = "1" ]; then
  SNAP_MODE="no-snapshot (quiet-window mode: refuses if anything changed during the backup)"
  info "WARNING: RG_NO_SNAPSHOT=1. No shared snapshot; the backup is accepted only if nothing changed while it ran."
  STEP="baseline (no-snapshot mode)"
  "${PSQL[@]}" -A -t -F'|' -f "$BASELINE_SQL" | grep -E '^(MUST|INFO)\|' > "${DIR}/baseline_before.txt" || true
  SCHEMAS="$("${PSQL[@]}" -A -t -c "$SCHEMA_SQL")"
else
  STEP="opening the snapshot session"
  FIFO="${WORK}/hold.fifo"; mkfifo "$FIFO"; : > "${WORK}/hold.out"
  psql -X -q -A -t -F'|' -v ON_ERROR_STOP=1 < "$FIFO" > "${WORK}/hold.out" 2> "${WORK}/hold.err" &
  HOLD_PID=$!
  exec 3> "$FIFO"
  {
    echo "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;"
    echo "SELECT 'SNAPSHOT:' || pg_export_snapshot();"
    echo "SELECT 'SCHEMAS:' || coalesce(($SCHEMA_SQL), '');"
    echo "\\echo BASELINE_BEGIN"
    echo "\\i ${BASELINE_SQL}"
    echo "\\echo BASELINE_END"
  } >&3
  i=0; until grep -q '^BASELINE_END$' "${WORK}/hold.out" 2>/dev/null; do
    kill -0 "$HOLD_PID" 2>/dev/null || die "the snapshot session ended unexpectedly (see diagnostics). The database may not support exported snapshots through this connection; see the runbook, RG_NO_SNAPSHOT."
    sleep 0.2; i=$((i+1)); [ "$i" -lt 600 ] || die "timed out waiting for the snapshot baseline."
  done
  SNAP="$(sed -n 's/^SNAPSHOT://p' "${WORK}/hold.out" | head -1)"
  SCHEMAS="$(sed -n 's/^SCHEMAS://p' "${WORK}/hold.out" | head -1)"
  [ -n "$SNAP" ] || die "the database did not return a snapshot id."
  sed -n '/^BASELINE_BEGIN$/,/^BASELINE_END$/p' "${WORK}/hold.out" | grep -E '^(MUST|INFO)\|' > "${DIR}/baseline_before.txt" || true
fi
[ -s "${DIR}/baseline_before.txt" ] || die "the baseline produced no output."
case " $SCHEMAS " in *" public "*) ;; *) die "schema public not found in the schema list.";; esac
info "Baseline recorded: $(grep -c '^MUST|' "${DIR}/baseline_before.txt") checks that must match after a restore. Mode: ${SNAP_MODE}"
printf '%s\n' "$SCHEMAS" > "${DIR}/schemas_included.txt"
SCHEMA_ARGS=(); for s in $SCHEMAS; do SCHEMA_ARGS+=("--schema=$s"); done
info "Schemas included: ${SCHEMAS}"

# ---- 2. ONE dump of that snapshot ----
STEP="pg_dump"
DUMP_ARGS=(--no-owner --no-comments "${SCHEMA_ARGS[@]}" -Fc)
[ -z "$SNAP" ] || DUMP_ARGS+=("--snapshot=${SNAP}")
info "Dumping once (custom format)..."
pg_dump "${DUMP_ARGS[@]}" -f "${DIR}/resume-db.dump" 2> "${WORK}/pg_dump.err" &
BG_PID=$!; wait "$BG_PID"; BG_PID=""
stop_holder                                             # the snapshot is no longer needed; this ends the read-only transaction

# ---- 3. readable files are DERIVED from that one archive (no second look at the database) ----
STEP="deriving schema.sql and data.sql from the archive"
pg_restore --no-owner --schema-only -f "${DIR}/schema.sql" "${DIR}/resume-db.dump"
pg_restore --no-owner --data-only -f "${DIR}/data.sql" "${DIR}/resume-db.dump"
pg_restore --list "${DIR}/resume-db.dump" > "${DIR}/archive_toc.txt"

# ---- 4. reconciliation: the archive must agree with the baseline taken at the same instant ----
STEP="reconciling the archive with the baseline"
awk '
  /^COPY / { split($0, a, " "); tbl = a[2]; sub(/^public\./, "", tbl); gsub(/"/, "", tbl); line = $0; sub(/^[^(]*\(/, "", line); sub(/\).*$/, "", line);
             n = split(line, cols, ", "); for (i = 1; i <= n; i++) { c = cols[i]; gsub(/"/, "", c); idx[tbl, c] = i }; incopy = 1; rows[tbl] = 0; seen[tbl] = 1; next }
  incopy && /^\\\.$/ { incopy = 0; next }
  incopy { rows[tbl]++; m = split($0, f, "\t");
           if (tbl == "licenses") { if (((tbl, "uses_remaining") in idx) && f[idx[tbl, "uses_remaining"]] != "\\N") rem += f[idx[tbl, "uses_remaining"]]; if (((tbl, "max_uses") in idx) && f[idx[tbl, "max_uses"]] != "\\N") mx += f[idx[tbl, "max_uses"]] } }
  END { for (t in seen) printf "rows|%s|%d\n", t, rows[t]; printf "sum|generations_remaining|%d\nsum|generations_max|%d\n", rem, mx }
' < "${DIR}/data.sql" | sort > "${WORK}/archive_counts.txt"
want_counts="$(sed -n 's/^MUST|public.table_row_counts|//p' "${DIR}/baseline_before.txt")"
want_rem="$(sed -n 's/^MUST|licenses.generations_remaining|//p' "${DIR}/baseline_before.txt")"
want_max="$(sed -n 's/^MUST|licenses.generations_max|//p' "${DIR}/baseline_before.txt")"
(
  bad=0
  OLDIFS="$IFS"; IFS=','; for kv in $want_counts; do
    t="${kv%%=*}"; n="${kv#*=}"; got="$(sed -n "s/^rows|${t}|//p" "${WORK}/archive_counts.txt")"
    if [ "$got" != "$n" ]; then echo "MISMATCH table ${t}: baseline ${n} rows, archive ${got:-none}"; bad=1; fi
  done; IFS="$OLDIFS"
  [ "$(sed -n 's/^sum|generations_remaining|//p' "${WORK}/archive_counts.txt")" = "$want_rem" ] || { echo "MISMATCH generations remaining: baseline ${want_rem}, archive $(sed -n 's/^sum|generations_remaining|//p' "${WORK}/archive_counts.txt")"; bad=1; }
  [ "$(sed -n 's/^sum|generations_max|//p' "${WORK}/archive_counts.txt")" = "$want_max" ] || { echo "MISMATCH generations max: baseline ${want_max}, archive $(sed -n 's/^sum|generations_max|//p' "${WORK}/archive_counts.txt")"; bad=1; }
  [ -n "$want_counts" ] || { echo "MISMATCH: baseline has no table row counts"; bad=1; }
  echo "reconciliation_result: $([ "$bad" = 0 ] && echo consistent || echo CONFLICT)"
  exit "$bad"
) > "${WORK}/reconcile.txt" || { cat "${WORK}/reconcile.txt" >&2; die "the dump and the baseline describe DIFFERENT database states (something changed while the backup ran, or snapshots are not honoured here). The backup was rejected and all plaintext deleted. Retry in a quiet window."; }
info "Reconciled: archive row counts and generation totals equal the baseline."

# ---- 5. activity check after the dump (a second, independent look) ----
STEP="activity check"
"${PSQL[@]}" -A -t -F'|' -f "$BASELINE_SQL" | grep -E '^MUST\|' | sort > "${WORK}/after.txt" || true
grep '^MUST|' "${DIR}/baseline_before.txt" | sort > "${WORK}/before.txt"
if diff -q "${WORK}/before.txt" "${WORK}/after.txt" >/dev/null 2>&1; then ACTIVITY="no changes while the backup ran"
else
  ACTIVITY="the live database changed while the backup ran (the backup is still consistent as of the snapshot instant)"
  if [ -z "$SNAP" ]; then die "no shared snapshot was used and the database changed while the backup ran, so the pieces cannot be trusted to agree. Rejected; retry in a quiet window."; fi
fi
info "Activity check: ${ACTIVITY}."

# ---- 6. manifest + checksums ----
STEP="manifest and checksums"
{
  echo "Flex & Grace Resume Project backup"
  echo "created_utc: ${STAMP}"
  echo "project_ref_expected: ${EXPECTED_REF}"
  echo "server_version: ${SERVER_VERSION}"
  echo "pg_dump_version: $(pg_dump --version)"
  echo "schemas: ${SCHEMAS}"
  echo "workspace: ${WORKSPACE_KIND}"
  echo "consistency: ${SNAP_MODE}"
  echo "snapshot_id_used: ${SNAP:-none}"
  echo "reconciliation: archive agrees with baseline (row counts and generation totals)"
  echo "activity_during_backup: ${ACTIVITY}"
  echo "contains_customer_data: yes (license codes, buyer e-mail addresses). Encrypt, never commit, never share."
  echo "status: NOT VERIFIED until scripts/backup/verify-restore-local.sh prints RESULT: PASS"
} > "${DIR}/manifest.txt"
( cd "$DIR" && sha256 resume-db.dump schema.sql data.sql archive_toc.txt baseline_before.txt manifest.txt schemas_included.txt > SHA256SUMS )

# ---- 7. encrypt into ONE file, prove it decrypts, then everything plaintext is deleted by the trap ----
STEP="encrypting"
tar -C "$WORK" -cf - "$NAME" | openssl enc "${ENC_ARGS[@]}" -out "${ENC}.partial"
STEP="checking the encrypted file"
mkdir "${WORK}/check"
openssl enc -d "${ENC_ARGS[@]}" -in "${ENC}.partial" | tar -C "${WORK}/check" -xf -
( cd "${WORK}/check/${NAME}" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS >/dev/null; else shasum -a 256 -c SHA256SUMS >/dev/null; fi ) || die "the encrypted copy failed its checksum test. It was deleted."
mv "${ENC}.partial" "$ENC"
ENC_SUM="$(sha256 "$ENC" | cut -d' ' -f1)"

STEP="writing the safe summary"
mkdir -p "$SUMMARY"
cp "${DIR}/baseline_before.txt" "${DIR}/manifest.txt" "${DIR}/SHA256SUMS" "${DIR}/schemas_included.txt" "$SUMMARY/"
printf '%s  %s\n' "$ENC_SUM" "$(basename "$ENC")" > "${SUMMARY}/ENCRYPTED_FILE.sha256"
printf 'RESULT: NOT YET VERIFIED\nRun scripts/backup/verify-restore-local.sh on the .tar.enc file. Until it prints RESULT: PASS this backup must not be relied on.\n' > "${SUMMARY}/verification.txt"
SUCCESS=1

info ""
info "BACKUP CREATED, NOT YET VERIFIED."
info "  Encrypted file : ${ENC}"
info "  SHA-256        : ${ENC_SUM}"
info "  Safe summary   : ${SUMMARY}/   (counts and fingerprints only; no customer data)"
info "  Consistency    : ${SNAP_MODE}; ${ACTIVITY}"
info "All unencrypted working files were deleted. NEXT, and required before this backup counts:"
info "  scripts/backup/verify-restore-local.sh \"${ENC}\"   (must print RESULT: PASS)"
