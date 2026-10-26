# Migration 03: deployment (superseded by the review package)

The deployment order, read-only preflight, verification, schema-cache note, duplicate-charge smoke test, abort criteria, rollback prerequisites and recovery guidance now live in **`docs/MIGRATION_03_REVIEW_PACKAGE.md`** (sections 7 and 8), with the read-only checks in `docs/MIGRATION_03_PREFLIGHT.sql` and the rollback in `supabase/rollback/20261023_03_rollback.sql`. This file is kept only so older links resolve. Nothing has been applied to production.
