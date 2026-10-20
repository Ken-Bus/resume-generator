-- Migration 02 of 02 — F-11: stop the public (anon/authenticated) roles from calling consume_license_use.
-- This is the single statement that needs its own approval. The only legitimate caller
-- (Netlify, via the service-role key) keeps access through its existing explicit grant.
-- To undo:  grant execute on function public.consume_license_use(text) to public;
revoke execute on function public.consume_license_use(text) from public, anon, authenticated;
