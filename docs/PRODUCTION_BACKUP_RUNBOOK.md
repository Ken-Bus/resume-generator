# Production backup runbook: Flex & Grace Resume Project (Supabase Free)

Target: **Flex & Grace Resume Project**, project reference `mvtgifohlwlyedokiyhb`. The separate Etsy Seller Manager project is out of scope and the scripts refuse to run against any other project reference.
Status: **prepared and tested locally with fictional data only. Nothing here has been run against production.** Claude has not read, exported or connected to any production record. Applying migrations 03 or 04 is blocked until the gate in section 8 is PASS.

## 1. Recommendation (no purchase, no plan change)

| Option | Verdict |
|---|---|
| **A. `pg_dump` over the Session pooler, driven by `scripts/backup/backup-resume-db.sh` (recommended)** | One command, read-only, consistent single snapshot, encrypted result, built-in restore test. Needs only free PostgreSQL client tools. |
| B. Supabase CLI `supabase db dump` (roles.sql, schema.sql, data.sql) | The method Supabase documents. Same data. Needs the CLI **and Docker Desktop**. Use it as the fallback if option A cannot be installed. |
| C. Dashboard SQL editor "download CSV" of `licenses` and `license_reservations` | Not a restorable backup on its own (no functions, grants, constraints). Last-resort supplement only. |
| D. Supabase automatic daily backups / PITR | **Not available on the Free plan** (Pro and up). Not purchased. |

## 2. What the official documentation says (checked 2026-10-25)
supabase.com cannot be fetched from Claude's environment, so these come from Supabase's own docs source in its public GitHub repository (`apps/docs/content/guides/platform/backups.mdx`, `.../migrating-within-supabase/backup-restore.mdx`, `.../database/connecting-to-postgres.mdx`, `.../spec/cli_v1_commands.yaml`) and the pricing page via search. Menu names in the dashboard may have moved; please confirm on screen.
- Daily backups exist only for Pro, Team and Enterprise. For Free the docs tell you to export regularly with the CLI `db dump` command and keep off-site copies.
- Documented backup: `supabase db dump --db-url <conn> -f roles.sql --role-only`, `-f schema.sql`, and `-f data.sql --use-copy --data-only`; documented restore: `psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql --command 'SET session_replication_role = replica' --file data.sql --dbname <conn>`. The CLI runs `pg_dump` in a container and **excludes Supabase-managed schemas (`auth`, `storage`, extension schemas)**; by default it dumps no data and no custom roles unless asked.
- Connection: the direct connection is **IPv6-only on the Free plan**; the **Session pooler (port 5432, user `postgres.<project-ref>`) works over IPv4 on every plan** and supports what `pg_dump` needs. The Transaction pooler (port 6543) does not support prepared statements: do not use it for dumps. Use SSL (`sslmode=require`).
- Restore caveats from the docs: custom role passwords are not stored; roles with LOGIN need new passwords; `supabase_admin` ownership lines and a `cli_login_postgres` grant line can fail in a restore and must be commented out; the docs do **not** discuss PostgreSQL version compatibility (see section 7).
- Free plan facts: 2 active projects, 500 MB per project, projects pause after 1 week of inactivity (paused projects do not count toward the 2), egress 5 GB, manual backups through the pooler count as egress.

## 3. One-time tools on the owner's computer (all free)
You need `psql`, `pg_dump`, `pg_restore` (PostgreSQL client tools), `openssl` and `tar`, in a **bash** shell. **The client tools must be the same major version as the Supabase server, or newer.** Find the server version in the dashboard (Project Settings → Infrastructure; Claude cannot see it).
- **Windows:** install Git for Windows (gives Git Bash, `openssl`, `tar`), then the PostgreSQL installer from postgresql.org and tick only **Command Line Tools**; add its `bin` folder to PATH. Run the scripts from Git Bash. (PowerShell is not supported.)
- **macOS:** `brew install libpq openssl` and add both to PATH (`brew` prints the lines). The built-in `openssl` (LibreSSL) may be too old for `-pbkdf2`; use Homebrew's.
- **Linux:** `sudo apt install postgresql-client-17` (use the server's major number) plus `openssl`.
- For the restore test you also need a **local PostgreSQL server** of the same or newer major version. If you have none: install Docker Desktop and run `docker run -d --name rgpg -e POSTGRES_PASSWORD=localtest -p 55432:5432 postgres:17`, then set `PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=localtest` for the verify command (use the server's real major number in place of 17).

## 4. What the backup preserves (and what it deliberately does not)
| Preserved by the dump of the app schemas (`public`, plus `supabase_migrations` and any other user schema the script finds) | How it is proven after a test restore |
|---|---|
| License data: `licenses` (codes, balances, assignment, buyer e-mail) | row count, generations remaining/spent, fingerprint of every `(code, uses, max, assigned)` |
| `license_reservations` (the permanent charge record), Tailor-run counts; `result_recovery` if migration 04 exists | row counts, status counts, fingerprint of `(id, code, status)` |
| Every function (`reserve_license_use`, `commit_license_use`, `release_license_use`, `consume_license_use`, `consume_tailor_use`, `refund_tailor_use`, ...) incl. security-definer flag and `search_path` | hash of names + arguments + flags + body |
| Tables, columns, defaults, constraints, indexes, triggers, RLS flags and policies | hashes of each |
| Permissions: table and function grants to `anon`, `authenticated`, `service_role`, schema usage, default privileges | hashes of each |
| Migration status (01 / 02 / 03 / 04 objects present) | exact state label and object list |

Not in the database dump, so noted separately (names only, never values):
- **Netlify environment variables** (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `TAILOR_TOKEN_SECRET`, `AI_TIMEOUT_MS`, and later `RESULT_ENCRYPTION_KEY`): confirm each value is in your password manager. Claude never sees them.
- **Roles themselves:** `anon`, `authenticated`, `service_role` are created by Supabase in every project; the baseline lists any other role (INFO `roles_non_system`). Custom role passwords are never in a dump.
- **Supabase-managed data** (`auth`, `storage`, Vault, `pg_cron`): the baseline prints their row counts. This app is expected to use none; **if any is above 0, STOP and tell Claude**, because the dump does not include them.
- The Google Apps Script / Etsy delivery automation and Netlify configuration: not database objects.

## 5. Minimum owner actions
1. (once) Install the tools in section 3. Get the server's Postgres major number.
2. In the dashboard open the Resume project → **Connect** → **Session pooler**; copy the **host** (not secret). The user name is `postgres.mvtgifohlwlyedokiyhb`, port `5432`. Know the database password. If you cannot find it, you can reset it under Database settings; the app talks to Supabase through API keys (the service-role key in Netlify), not this password, so a reset should not affect it, but confirm nothing else of yours connects directly before resetting.
3. Pick a quiet moment (few or no customers), open Git Bash / Terminal in the repository folder and run:
   `scripts/backup/backup-resume-db.sh`
   It asks for the host, the database password (hidden) and an encryption passphrase (hidden, 12+ characters; store it in your password manager, not beside the backup). It prints `DONE` and writes one `.tar.enc` file plus a small `.summary` folder under `~/resume-generator-backups/`.
4. Prove it restores:
   `scripts/backup/verify-restore-local.sh ~/resume-generator-backups/resume-backup-<stamp>.tar.enc`
   (asks for the passphrase). It must end with `RESULT: PASS`.
5. Send Claude only the contents of the `.summary` folder (counts and fingerprints, no customer data) so the baseline can be recorded in the release checklist. Never send the `.enc` file or the passphrase.
6. Store the `.enc` file as in section 6. That is all: two commands and three hidden prompts.

**No production access by Claude is needed.** If you would rather have Claude run the dump, that requires your explicit approval of this exact operation: a read-only `pg_dump` plus `docs/BACKUP_BASELINE.sql` over the Session pooler, and it would require you to give Claude the database password. Claude advises against that (standing rule: no credentials in AI chats). Not requested.

## 6. Storing the backup and protecting customer data
The backup contains license codes (which act as passwords) and buyer e-mail addresses. Treat it like a secret.
- Two copies of the **encrypted** `.tar.enc` only: (1) an encrypted local disk (BitLocker / FileVault) and (2) a private cloud folder or offline USB. Never the unencrypted dump folder (the script deletes it; do not set `RG_KEEP_PLAINTEXT`).
- The passphrase lives in the password manager, never in the same place as the file, never in chat, email or a ticket.
- Never commit it: `.gitignore` now blocks `*.tar.enc`, `*.dump`, `resume-backup-*` and `resume-generator-backups/`. Never upload it to GitHub, Netlify, Etsy, an AI chat or a shared drive other people can open.
- Keep it until 30 days after the migrations are released and verified, then delete it (delete the cloud copy and empty its trash). Do not keep old backups indefinitely: they contain customer e-mails.
- The script never prints a code, e-mail or password; the `.summary` files contain counts and MD5 fingerprints only (tested).

## 7. Limitations and risks (stated plainly)
| Risk | Detail / mitigation |
|---|---|
| **Tested locally only** | The scripts were proven on local PostgreSQL 16 with fictional data (see section 9). Not tested against real Supabase, a PostgreSQL 15/17 server, Windows Git Bash or macOS. First real run is the real test; the verify step is the safety net. |
| **PostgreSQL version** | `pg_dump` refuses a server newer than itself; the script stops with a clear message. A dump from a newer server may not restore into an older local server; verify refuses that too. Supabase docs say nothing about version compatibility. |
| **Roles and permissions** | Grants are dumped and proven equal after restore; role passwords and the roles themselves are not. `--no-owner` is used, so objects belong to whoever restores. Real Supabase dumps may carry `supabase_admin` ownership/grant lines that fail on a vanilla server; the verify script pre-creates the usual Supabase roles to avoid that and reports any remaining error. |
| **Restoring into the same project is destructive** | Do not do it to "undo" a migration. Undo migrations with the tested rollback scripts (`supabase/rollback/`); use the backup for data recovery (targeted `COPY` of `licenses` / `license_reservations`) or catastrophe. Any restore into production needs your approval and a fresh plan. |
| **Free plan has 2 active projects** | A "restore into a brand-new project" needs a free slot; you already run two. Do **not** pause or delete the Etsy Seller Manager project for this. Realistic restore targets: local PostgreSQL (verification) or targeted repair of the same project. |
| **Point in time** | The backup is a single consistent snapshot, but customers can charge codes afterwards. Take it in a quiet window right before migrating; the migration preflight prints the balance fingerprint again so any drift is visible and explainable by committed charges. |
| **Paused project / egress** | A Free project pauses after a week of inactivity (take the backup while active). The dump is small; it still counts as egress. |
| **Managed schemas not included** | `auth`, `storage`, Vault, cron: expected unused; the baseline prints their counts. |
| **Passphrase loss** | An encrypted backup without its passphrase is unrecoverable. Store the passphrase first. |

## 8. Gate: verified backup before any migration (feeds G0 of `docs/MIGRATION_04_RELEASE_VERIFICATION.md`)
| Check | PASS | FAIL (repeat) | STOP |
|---|---|---|---|
| Backup script finished | prints `DONE`, one `.tar.enc`, a `.summary` folder | connection/permission/tool error: fix and rerun (nothing was changed in production) | it reports the project is not `mvtgifohlwlyedokiyhb`, or the baseline shows `auth.users`, `storage.objects` or Vault rows above 0 |
| Restore test | `RESULT: PASS` for restore A and B | any `FAIL`: do not use this backup, rerun the backup, then verify again | it fails twice on a fresh backup |
| Baseline recorded | summary counts saved in the release notes | | counts look wrong to you (e.g. far fewer licenses than expected) |
| Storage | two encrypted copies, passphrase in the password manager, file hash recorded (`ENCRYPTED_FILE.sha256`) | | passphrase or file was shared in a chat/commit: treat as exposed, delete, redo |
Only when every row is PASS may G0 of the migration checklist be ticked. Repeat the baseline (`docs/BACKUP_BASELINE.sql`, safe to paste into the SQL editor) just before migration 03 and compare with `baseline_before.txt`; differences must be explained by real customer charges.

## 9. Evidence (local, fictional data; `tests/db/backup-restore.test.js`)
- Backup, encrypt, decrypt and two independent restores (pg_restore and psql `schema.sql` + `data.sql`) each match every baseline check for states 01+02, 03, and 03+04, including Supabase-style schema grants.
- The encrypted file, the printed output and the clear summary contain no license code, e-mail address or passphrase; the plaintext folder is removed; the file mode is private.
- Verification FAILS for: a flipped byte, a wrong passphrase, tampered contents, and a baseline that differs in balances, fingerprints, row counts, grants, function bodies or migration state.
- Guards work: wrong project reference, transaction pooler port, `pg_dump` older than the server, a database that is not the Resume project, and a remote restore target are all refused without leaving files behind.
- The baseline SQL runs in a read-only session and prints counts and fingerprints only.
