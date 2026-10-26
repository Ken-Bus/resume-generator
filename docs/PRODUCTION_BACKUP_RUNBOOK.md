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
- For the restore test you also need a **local PostgreSQL server** of the same or newer major version, and because it will hold a full copy of customer data while the check runs, it should be **RAM-backed**. Recommended: install Docker Desktop and run `docker run -d --rm --name rgpg -e POSTGRES_PASSWORD=localtest -p 55432:5432 --tmpfs /var/lib/postgresql/data:rw,size=1g postgres:17` (use the server's real major number; for image versions that changed the data path, mount the tmpfs there), then use `PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=localtest` for the verify command and `docker stop rgpg` afterwards. Its data lives only in memory, so a crash or power loss leaves nothing on disk.

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
1. (once) Install the tools in section 3. Get the server's Postgres major number. Prepare the **encrypted workspace** of section 5a and keep its path ready (`RG_WORKDIR`).
2. In the dashboard open the Resume project → **Connect** → **Session pooler**; copy the **host** (not secret). The user name is `postgres.mvtgifohlwlyedokiyhb`, port `5432`. Know the database password. If you cannot find it, you can reset it under Database settings; the app talks to Supabase through API keys (the service-role key in Netlify), not this password, so a reset should not affect it, but confirm nothing else of yours connects directly before resetting.
3. Pick a quiet moment (few or no customers), open Git Bash / Terminal in the repository folder and run:
   `RG_WORKDIR=<your encrypted workspace folder> scripts/backup/backup-resume-db.sh`
   It asks for the host, the database password (hidden) and an encryption passphrase (hidden, 12+ characters; store it in your password manager, not beside the backup). It prints `BACKUP CREATED, NOT YET VERIFIED` and writes one `.tar.enc` file plus a small `.summary` folder under `~/resume-generator-backups/`. If anything goes wrong it prints `FAILED in step ...`, leaves no backup file and no decrypted data, and writes a small `*.FAILED.txt` with masked diagnostics (no codes, e-mails or passwords) that you may share.
4. Prove it restores:
   `RG_WORKDIR=<your encrypted workspace folder> scripts/backup/verify-restore-local.sh ~/resume-generator-backups/resume-backup-<stamp>.tar.enc`
   (asks for the passphrase). It must end with `RESULT: PASS`; it also writes `RESULT: PASS` or `RESULT: FAIL` into `<backup>.summary/verification.txt`. A backup whose `verification.txt` does not say PASS is not usable.
5. Send Claude only the contents of the `.summary` folder (counts and fingerprints, no customer data) so the baseline can be recorded in the release checklist. Never send the `.enc` file or the passphrase.
6. Store the `.enc` file as in section 6. That is all: two commands, three hidden prompts, and one "type ENCRYPTED" confirmation per command unless your workspace is a RAM disk the script can recognise.

**No production access by Claude is needed.** If you would rather have Claude run the dump, that requires your explicit approval of this exact operation: a read-only `pg_dump` plus `docs/BACKUP_BASELINE.sql` over the Session pooler, and it would require you to give Claude the database password. Claude advises against that (standing rule: no credentials in AI chats). Not requested.

### How the script keeps the backup consistent and the plaintext contained
- **One instant.** It opens one read-only `REPEATABLE READ` transaction, exports its snapshot, takes the baseline inside it, and makes **one** `pg_dump --snapshot=<that snapshot>`. `schema.sql` and `data.sql` are derived from that same archive (never a second look at the database). Customers charging codes meanwhile cannot make the pieces disagree; the manifest records `snapshot_id_used` and whether the live database changed while it ran.
- **Reconciliation (does not trust the snapshot).** After the dump it reads the row counts of every public table and the sum of generations remaining/max back out of the archive and compares them with the baseline. Any mismatch rejects the backup, deletes everything and tells you to retry in a quiet window.
- **If your database or pooler cannot share a snapshot** the script stops (it never silently falls back). You may then run it in quiet-window mode: `RG_NO_SNAPSHOT=1 scripts/backup/backup-resume-db.sh`. That mode accepts a backup only if a second baseline, taken after the dump, is identical to the first (nothing changed while it ran).
- **Plaintext.** Everything unencrypted lives in one private work folder (`rg-backup-work.XXXXXX`, mode 700) **inside your encrypted workspace** (`RG_WORKDIR`, required for production) that is deleted on success, on any error, on Ctrl-C, on kill (TERM) and on hang-up. The passphrase and the openssl check happen **before** any customer data is read, so a wrong passphrase or broken openssl cannot strand a dump. The encrypted file is written as `.partial`, proven to decrypt and match its checksums, and only then renamed. The restore check decrypts into its own folder inside the same workspace, always removed, and drops its scratch databases on every outcome. **There is no option to keep a plaintext dump or a scratch database** (`RG_KEEP_PLAINTEXT` and `RG_KEEP_SCRATCH` were removed; setting them does nothing).
- **No false success.** The backup script says `NOT YET VERIFIED` and writes `verification.txt` accordingly; only a passing `verify-restore-local.sh` turns it into `PASS`, and a later failure overwrites an earlier PASS.

### 5a. Encrypted temporary workspace, SIGKILL / power-loss limits, and abandoned files
**The limit:** a script cannot clean up after `kill -9` (SIGKILL), a crash, a forced shutdown or a power cut. Ctrl-C, a normal kill and errors are all handled; those four are not. If one happens mid-backup the unencrypted work folder stays where it was. That is why the folder must be somewhere that is protected anyway:
- **Production runs refuse to start without `RG_WORKDIR`** pointing at an existing folder on an **encrypted or RAM-backed volume**, outside the repository. The script cannot prove disk encryption; it recognises a Linux RAM disk (`tmpfs`) automatically and otherwise makes you confirm (`type ENCRYPTED`, or `RG_WORKDIR_CONFIRMED=yes`), and it records which in the manifest (`workspace:`). The restore check has the same requirement because it decrypts the backup.
- **Create the workspace (free):**
  - *Linux (RAM disk, recognised automatically):* `sudo mkdir -p /mnt/rgwork && sudo mount -t tmpfs -o size=1g,mode=700,uid=$(id -u) tmpfs /mnt/rgwork`, then `export RG_WORKDIR=/mnt/rgwork`. Unmount when done: `sudo umount /mnt/rgwork`.
  - *macOS (RAM disk):* `diskutil erasevolume HFS+ RGWORK $(hdiutil attach -nomount ram://2097152)` gives a 1 GB volume at `/Volumes/RGWORK`; eject with `diskutil eject /Volumes/RGWORK`. Or use a folder on a FileVault-encrypted disk. Confirm when asked.
  - *Windows (Git Bash):* a folder on a BitLocker-encrypted drive/volume, or a free VeraCrypt volume if your Windows edition lacks BitLocker, for example `/d/rgwork`. Confirm when asked. (Claude cannot see your machine; check that encryption is really on.)
  - Size: about three times the database size (dump, derived files, and the decrypted check copy); 1 GB is ample for this project (the Free plan cap is 500 MB).
- **Startup check for abandoned files.** Before touching the database the backup script looks in `RG_WORKDIR` and the backup folder for `rg-backup-work.*` (and the older `.work.*`) folders; the restore check looks for `rg-verify.*` folders and for leftover scratch databases `rg_restore_a_*` / `rg_restore_b_*` on the local server. If any exist it **stops, lists their names (never their contents), and contacts nothing**. Do not open, copy, zip or upload them.
- **Handling them without exposing customer data:**
  1. Best: destroy the whole workspace: unmount/eject the RAM disk (contents vanish), or delete the encrypted container/volume. Stopping the RAM-backed Docker Postgres (`docker stop rgpg`) removes any leftover scratch databases.
  2. Otherwise delete exactly what the script printed: `rm -rf '<path shown>'` and `dropdb --force <name shown>`. On an encrypted or RAM volume this is sufficient; on an ordinary disk deletion is not secure erasure, which is why such a disk is not allowed.
  3. Or rerun with `RG_DELETE_ABANDONED=yes`, which deletes only folders matching those exact names (and drops only databases matching `rg_restore_[ab]_<number>`) and prints what it removed.
  4. Run the backup again from the start; an interrupted backup is never resumed or reused.
- Run only one backup/verify at a time: a second simultaneous run would look like an abandoned one.

## 6. Storing the backup and protecting customer data
The backup contains license codes (which act as passwords) and buyer e-mail addresses. Treat it like a secret.
- Two copies of the **encrypted** `.tar.enc` only: (1) an encrypted local disk (BitLocker / FileVault) and (2) a private cloud folder or offline USB. Never an unencrypted dump: the scripts never keep one, and the verify script refuses an unencrypted folder.
- The passphrase lives in the password manager, never in the same place as the file, never in chat, email or a ticket.
- Never commit it: `.gitignore` now blocks `*.tar.enc`, `*.dump`, `resume-backup-*` and `resume-generator-backups/`. Never upload it to GitHub, Netlify, Etsy, an AI chat or a shared drive other people can open.
- Keep it until 30 days after the migrations are released and verified, then delete it (delete the cloud copy and empty its trash). Do not keep old backups indefinitely: they contain customer e-mails.
- The script never prints a code, e-mail or password; the `.summary` files contain counts and MD5 fingerprints only (tested).

## 7. Limitations and risks (stated plainly)
| Risk | Detail / mitigation |
|---|---|
| **Tested locally only** | The scripts were proven on local PostgreSQL 16 with fictional data (see section 9). Not tested against real Supabase, a PostgreSQL 15/17 server, Windows Git Bash or macOS. First real run is the real test; the verify step is the safety net. |
| **Snapshot through the Supabase pooler is unproven** | Exported snapshots need the snapshot session and `pg_dump` to share one database, which the Session pooler (one server connection per client connection) should allow, but this has not been tried on Supabase. If it fails the script stops with a clear message; use quiet-window mode (`RG_NO_SNAPSHOT=1`) in a moment with no customers. The reconciliation step protects either way. |
| **PostgreSQL version** | `pg_dump` refuses a server newer than itself; the script stops with a clear message. A dump from a newer server may not restore into an older local server; verify refuses that too. Supabase docs say nothing about version compatibility. |
| **Roles and permissions** | Grants are dumped and proven equal after restore; role passwords and the roles themselves are not. `--no-owner` is used, so objects belong to whoever restores. Real Supabase dumps may carry `supabase_admin` ownership/grant lines that fail on a vanilla server; the verify script pre-creates the usual Supabase roles to avoid that and reports any remaining error. |
| **Restoring into the same project is destructive** | Do not do it to "undo" a migration. Undo migrations with the tested rollback scripts (`supabase/rollback/`); use the backup for data recovery (targeted `COPY` of `licenses` / `license_reservations`) or catastrophe. Any restore into production needs your approval and a fresh plan. |
| **Free plan has 2 active projects** | A "restore into a brand-new project" needs a free slot; you already run two. Do **not** pause or delete the Etsy Seller Manager project for this. Realistic restore targets: local PostgreSQL (verification) or targeted repair of the same project. |
| **Point in time** | The backup is a single consistent snapshot, but customers can charge codes afterwards. Take it in a quiet window right before migrating; the migration preflight prints the balance fingerprint again so any drift is visible and explainable by committed charges. |
| **Paused project / egress** | A Free project pauses after a week of inactivity (take the backup while active). The dump is small; it still counts as egress. |
| **Managed schemas not included** | `auth`, `storage`, Vault, cron: expected unused; the baseline prints their counts. |
| **SIGKILL / power loss** | No script can clean up after these. Mitigations: the work folder exists only inside an encrypted or RAM-backed workspace (required), the next run refuses to start until abandoned folders/scratch databases are removed, and the local Postgres for the restore check should be RAM-backed (section 5a). A hard kill during the dump also ends the snapshot session by itself (its pipe closes). |
| **Passphrase loss** | An encrypted backup without its passphrase is unrecoverable. Store the passphrase first. |

## 8. Gate: verified backup before any migration (feeds G0 of `docs/MIGRATION_04_RELEASE_VERIFICATION.md`)
| Check | PASS | FAIL (repeat) | STOP |
|---|---|---|---|
| Workspace | `RG_WORKDIR` is an encrypted or RAM-backed folder outside the repository; no abandoned work folders were reported (or they were removed as in 5a) | the script refused: fix as 5a says | an abandoned folder cannot be removed, or you cannot confirm the volume is encrypted |
| Backup script finished | prints `Reconciled: ...` and `BACKUP CREATED, NOT YET VERIFIED`, one `.tar.enc`, a `.summary` folder | connection/permission/tool error: fix and rerun (nothing was changed in production) | it reports the project is not `mvtgifohlwlyedokiyhb`, or the baseline shows `auth.users`, `storage.objects` or Vault rows above 0 |
| Restore test | `RESULT: PASS` for restore A and B, and `verification.txt` says PASS | any `FAIL`: do not use this backup, rerun the backup, then verify again | it fails twice on a fresh backup |
| Baseline recorded | summary counts saved in the release notes | | counts look wrong to you (e.g. far fewer licenses than expected) |
| Storage | two encrypted copies, passphrase in the password manager, file hash recorded (`ENCRYPTED_FILE.sha256`) | | passphrase or file was shared in a chat/commit: treat as exposed, delete, redo |
Only when every row is PASS may G0 of the migration checklist be ticked. Repeat the baseline (`docs/BACKUP_BASELINE.sql`, safe to paste into the SQL editor) just before migration 03 and compare with `baseline_before.txt`; differences must be explained by real customer charges.

## 9. Evidence (local, fictional data; `tests/db/backup-restore.test.js`)
- Backup, encrypt, decrypt and two independent restores (pg_restore and psql `schema.sql` + `data.sql`) each match every baseline check for states 01+02, 03, and 03+04, including Supabase-style schema grants.
- The encrypted file, the printed output and the clear summary contain no license code, e-mail address or passphrase; the plaintext folder is removed; the file mode is private.
- Verification FAILS for: a flipped byte, a wrong passphrase, tampered contents, and a baseline that differs in balances, fingerprints, row counts, grants, function bodies or migration state.
- Guards work: wrong project reference, transaction pooler port, `pg_dump` older than the server, a database that is not the Resume project, and a remote restore target are all refused without leaving files behind.
- The baseline SQL runs in a read-only session and prints counts and fingerprints only.
- Final safeguards (`tests/db/backup-safeguards.test.js`, 14 checks in total): no keep-plaintext or keep-scratch option exists and setting the old variables changes nothing; a Supabase-looking connection without an encrypted workspace, with a missing folder, a folder inside the repository or an unconfirmed folder is refused before the database is contacted; the workspace kind is recorded in the manifest; a hard `SIGKILL` of a running backup leaves the work folder only inside the workspace, the next run refuses without opening it and prints removal commands, `RG_DELETE_ABANDONED=yes` clears it, and no snapshot session stays open; the restore check likewise refuses leftover decrypted folders and scratch databases without showing their contents; the restore check refuses an unencrypted folder.
- Earlier safeguard tests: a balance changed mid-dump leaves a backup consistent as of the snapshot that restores to that exact state; an ignored snapshot is rejected by the reconciliation; quiet-window mode rejects even a change the counts cannot see; SIGTERM and SIGINT mid-dump exit non-zero, delete the plaintext work folder, create no backup file and end the snapshot database session; a missing/short passphrase or an openssl without `-pbkdf2` stops before any data is read; an encryption failure after the dump leaves no plaintext, `.partial` or summary; failed verification (wrong passphrase, damage, mismatch) writes `RESULT: FAIL`, leaves no decrypted files, and a later failure overwrites an earlier PASS. Five deliberate breakages of the scripts (no snapshot argument, reconciliation ignored, work folder not removed, verify always PASS, activity check skipped) were each caught.
