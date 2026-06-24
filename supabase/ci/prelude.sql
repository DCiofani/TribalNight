-- Shim per applicare/testare lo schema Supabase su Postgres "vanilla" in CI.
-- In Supabase questi oggetti esistono già (ruoli + schema auth). Qui li ricreiamo minimi.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema if not exists auth;

-- auth.uid(): legge il sub dal claim JWT (come Supabase). In test si imposta via SET request.jwt.claims.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role() returns text language sql stable as $$
  select 'authenticated';
$$;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;
