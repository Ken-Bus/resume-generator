-- ROLLBACK for migration 04 (20261024_04_result_recovery.sql). NOT a migration: never run automatically.
-- Removes the four functions and the result_recovery table. At most 24 hours of recovery copies are lost (recovery then falls back to the behaviour
-- of migration 03). It does NOT touch licenses, balances or any reservation row (the permanent charge record): nothing a customer paid for changes.
-- ORDER: redeploy the previous Netlify build FIRST. The new build refuses to charge without its recovery copy, so against a rolled-back database it
-- answers "try again" and charges nothing; the previous build does not use these objects at all.
begin;
drop function if exists commit_license_use_with_result(uuid, text, text, text, text, text, integer);
drop function if exists list_recoverable_results(text);
drop function if exists fetch_recoverable_result(text, uuid);
drop function if exists purge_recoverable_results();
drop table if exists result_recovery;
commit;
