#!/usr/bin/env bash
# Flex & Grace Resume Generator: READ-ONLY logical backup of the Supabase database (Free plan, no paid service).
#
# What it does (nothing is ever written to the database):
#   1. connects with your own database password (typed at a hidden prompt, never stored, never printed);
#   2. checks it is the RESUME project (not the Etsy Seller Manager one) and that your pg_dump is new enough for the server;
#   3. records a read-only baseline (counts and fingerprints only, no codes or e-mails);
#   4. dumps the app schemas with pg_dump (custom format + readable schema.sql + data.sql), lists the archive to prove it is readable;
#   5. writes SHA256SUMS and a manifest, then packs everything into ONE encrypted file (AES-256, passphrase typed at a hidden prompt).
#
# Run it from the repository root (or anywhere): scripts/backup/backup-resume-db.sh
# Needs: bash, psql, pg_dump, pg_restore (PostgreSQL client tools, same major version as the server or newer), openssl, tar, sha256sum or shasum.
# Customer data is in the output. Keep the .enc file private. Never commit it, e-mail it, or paste any of it into an AI chat.
set -euo pipefail
umask 077

EXPECTED_REF="${RG_EXPECTED_REF:-mvtgifohlwlyedokiyhb}"          # Flex & Grace Resume Project
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASELINE_SQL="${HERE}/../../docs/BACKUP_BASELINE.sql"
OUT_ROOT="${RG_BACKUP_DIR:-$HOME/resume-generator-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="resume-backup-${STAMP}"

die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed or not on PATH (see docs/PRODUCTION_BACKUP_RUNBOOK.md, section 3)."; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

for t in psql pg_dump pg_restore openssl tar; do need "$t"; done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || die "neither sha256sum nor shasum is available."
[ -r "$BASELINE_SQL" ] || die "cannot find docs/BACKUP_BASELINE.sql next to this script."

# ---- connection (libpq environment variables; the password is read hidden) ----
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

if [ "$LOCAL" = 0 ]; then
  [ "$PGPORT" != "6543" ] || die "port 6543 is the transaction pooler; pg_dump needs the Session pooler (port 5432)."
  case "$PGUSER" in "postgres.${EXPECTED_REF}") ;; *) [ "$PGHOST" = "db.${EXPECTED_REF}.supabase.co" ] || die "this connection is not for project ${EXPECTED_REF} (Flex & Grace Resume Project). Refusing to continue. The user name must be postgres.${EXPECTED_REF}.";; esac
fi

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -A -t -c "select 1" >/dev/null 2>&1 || die "could not connect. Check host, port 5432, user, password and that the project is not paused."

# ---- safety checks ----
SERVER_NUM="$("${PSQL[@]}" -A -t -c "show server_version_num")"; SERVER_MAJOR=$(( SERVER_NUM / 10000 ))
CLIENT_MAJOR="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
info "Server PostgreSQL major version: ${SERVER_MAJOR}; your pg_dump major version: ${CLIENT_MAJOR}"
[ "$CLIENT_MAJOR" -ge "$SERVER_MAJOR" ] || die "your pg_dump (${CLIENT_MAJOR}) is OLDER than the server (${SERVER_MAJOR}); pg_dump refuses that. Install PostgreSQL client tools ${SERVER_MAJOR} or newer."
HAS="$("${PSQL[@]}" -A -t -c "select to_regclass('public.licenses') is not null")"
[ "$HAS" = "t" ] || die "table public.licenses not found: this is not the Resume project database. Nothing was dumped."

# ---- output folder ----
mkdir -p "$OUT_ROOT"; chmod 700 "$OUT_ROOT"
DIR="${OUT_ROOT}/${NAME}"; mkdir "$DIR"
info "Working folder: ${DIR}"

# ---- 1. baseline (counts and fingerprints only) ----
"${PSQL[@]}" -A -t -F'|' -f "$BASELINE_SQL" | grep -E '^(MUST|INFO)\|' > "${DIR}/baseline_before.txt"
[ -s "${DIR}/baseline_before.txt" ] || die "the baseline produced no output."
info "Baseline recorded: $(grep -c '^MUST|' "${DIR}/baseline_before.txt") checks that must match after a restore."

# ---- 2. which schemas ----
SCHEMAS="$("${PSQL[@]}" -A -t -c "select string_agg(nspname, ' ' order by nspname) from pg_namespace where nspname !~ '^(pg_|information_schema)' and nspname not in ('auth','storage','realtime','vault','extensions','graphql','graphql_public','pgsodium','pgsodium_masks','net','cron','pgbouncer','supabase_functions','_realtime','_analytics','supavisor','pgmq','pgmq_public','topology','tiger','tiger_data','cron_job_run_details') and (nspname = 'public' or exists (select 1 from pg_class c where c.relnamespace = pg_namespace.oid and c.relkind in ('r','p','v','m','S')) or exists (select 1 from pg_proc p where p.pronamespace = pg_namespace.oid))")"
case " $SCHEMAS " in *" public "*) ;; *) die "schema public not found in the schema list.";; esac
SCHEMA_ARGS=(); for s in $SCHEMAS; do SCHEMA_ARGS+=("--schema=$s"); done
info "Schemas included: ${SCHEMAS}"
printf '%s\n' "$SCHEMAS" > "${DIR}/schemas_included.txt"

# ---- 3. dump (pg_dump is read-only: one consistent snapshot) ----
COMMON=(--no-owner --no-comments "${SCHEMA_ARGS[@]}")
info "Dumping (custom format)..."
pg_dump "${COMMON[@]}" -Fc -f "${DIR}/resume-db.dump"
info "Dumping readable schema.sql and data.sql (for review and for the official psql restore path)..."
pg_dump "${COMMON[@]}" -Fp --schema-only -f "${DIR}/schema.sql"
pg_dump "${COMMON[@]}" -Fp --data-only -f "${DIR}/data.sql"

# ---- 4. prove the archive is readable and complete ----
pg_restore --list "${DIR}/resume-db.dump" > "${DIR}/archive_toc.txt"
TABLES="$("${PSQL[@]}" -A -t -c "select string_agg(quote_ident(schemaname)||'.'||quote_ident(tablename), ' ' order by 1) from pg_tables where schemaname = any(string_to_array('$(printf '%s' "$SCHEMAS" | tr ' ' ',')', ','))")"
MISSING=""
for t in $TABLES; do tn="${t#*.}"; tn="${tn//\"/}"; grep -q "TABLE DATA .* ${tn} " "${DIR}/archive_toc.txt" || MISSING="${MISSING} ${t}"; done
[ -z "$MISSING" ] || die "the archive has no data entry for:${MISSING}"
info "Archive readable; data present for every table."

# ---- 5. manifest + checksums ----
{
  echo "Flex & Grace Resume Project backup"
  echo "created_utc: ${STAMP}"
  echo "project_ref_expected: ${EXPECTED_REF}"
  echo "server_version: $("${PSQL[@]}" -A -t -c 'show server_version')"
  echo "pg_dump_version: $(pg_dump --version)"
  echo "schemas: ${SCHEMAS}"
  echo "tables: ${TABLES}"
  echo "contains_customer_data: yes (license codes, buyer e-mail addresses). Encrypt, never commit, never share."
} > "${DIR}/manifest.txt"
( cd "$DIR" && sha256 resume-db.dump schema.sql data.sql archive_toc.txt baseline_before.txt manifest.txt schemas_included.txt > SHA256SUMS )

# ---- 6. encrypt into ONE file ----
if [ -z "${RG_BACKUP_PASSPHRASE:-}" ]; then
  read -r -s -p "Choose an encryption passphrase (hidden; store it in your password manager, NOT next to the backup): " P1; printf '\n'
  read -r -s -p "Type it again: " P2; printf '\n'
  [ "$P1" = "$P2" ] && [ "${#P1}" -ge 12 ] || die "passphrases differ or are shorter than 12 characters. The unencrypted folder was left in ${DIR}; delete it yourself after fixing this."
  RG_BACKUP_PASSPHRASE="$P1"
fi
export RG_BACKUP_PASSPHRASE
ENC="${OUT_ROOT}/${NAME}.tar.enc"
tar -C "$OUT_ROOT" -cf - "$NAME" | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -pass env:RG_BACKUP_PASSPHRASE -out "$ENC"
# prove the encrypted file decrypts and its contents match the checksums
CHECK="$(mktemp -d)"; trap 'rm -rf "$CHECK"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:RG_BACKUP_PASSPHRASE -in "$ENC" | tar -C "$CHECK" -xf -
( cd "${CHECK}/${NAME}" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS >/dev/null; else shasum -a 256 -c SHA256SUMS >/dev/null; fi ) || die "the encrypted copy failed its checksum test. Do not rely on it."
ENC_SUM="$(sha256 "$ENC" | cut -d' ' -f1)"

# ---- 7. keep only the harmless summaries in clear, delete the plaintext data ----
mkdir -p "${OUT_ROOT}/${NAME}.summary"
cp "${DIR}/baseline_before.txt" "${DIR}/manifest.txt" "${DIR}/SHA256SUMS" "${DIR}/schemas_included.txt" "${OUT_ROOT}/${NAME}.summary/"
printf '%s  %s\n' "$ENC_SUM" "$(basename "$ENC")" > "${OUT_ROOT}/${NAME}.summary/ENCRYPTED_FILE.sha256"      # kept outside the archive: its own hash cannot be inside it
if [ "${RG_KEEP_PLAINTEXT:-0}" != "1" ]; then rm -rf "$DIR"; info "Unencrypted dump folder deleted."; fi

info ""
info "DONE. Encrypted backup : ${ENC}"
info "      SHA-256          : ${ENC_SUM}"
info "      Summary (safe)   : ${OUT_ROOT}/${NAME}.summary/   (counts and fingerprints only; no customer data)"
info "Next: run scripts/backup/verify-restore-local.sh \"${ENC}\" to prove it restores, then store the .enc file as described in docs/PRODUCTION_BACKUP_RUNBOOK.md."
