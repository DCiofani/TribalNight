-- ============================================================================
-- TOTEM NIGHT — 0000_prelude.sql
-- Versione di PRODUZIONE del prelude (oggi shim CI in supabase/ci/prelude.sql).
--
-- Su Supabase self-hosted i ruoli (anon/authenticated/service_role/authenticator)
-- e lo schema `auth` con auth.uid()/auth.role()/auth.jwt() esistono già: li crea
-- GoTrue/PostgREST. Su Postgres "vanilla" (plugin Railway) NON esistono. Questo file
-- li ricrea in modo idempotente così che 0001_init.sql/0002 (schema v0.2: 14 RPC
-- SECURITY DEFINER + RLS + grants `to authenticated`) si applichino INVARIATI.
--
-- ORDINE DI APPLICAZIONE (obbligatorio):
--   1. create extension pgcrypto   (gen_random_uuid; 0001 lo fa già, ma ok ripeterlo)
--   2. 0000_prelude.sql  ← QUESTO FILE  (ruoli + schema auth + authenticator)
--   3. 0001_init.sql
--   4. 0002_draws_select_staff.sql
--
-- Va applicato come `postgres` (owner/superuser del plugin). L'owner che applica
-- 0001 diventa l'owner delle 14 RPC SECURITY DEFINER: poiché `postgres` ≠
-- `authenticator`, il SECURITY DEFINER bypassa correttamente la RLS (l'ospite non
-- può scrivere `guests` direttamente, ma `topup()` sì perché gira come owner).
-- REGOLA D'ORO: l'owner delle RPC NON deve MAI essere `authenticator`, altrimenti
-- dopo `SET ROLE authenticated` il DEFINER diventa un no-op e la RLS viene bypassata
-- dal client.
-- ============================================================================

-- Estensione per gen_random_uuid() (idempotente; 0001 la richiede comunque).
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1) RUOLI
--
--   anon / authenticated / service_role : ruoli NOLOGIN NOINHERIT. Non sono utenti
--     di connessione: si "indossano" via `SET ROLE` dentro la transazione. NOINHERIT
--     perché authenticator NON deve ereditarne automaticamente i privilegi: li
--     ottiene SOLO con un `SET ROLE` esplicito (è ciò che rende sicuro esporre
--     authenticator come ruolo di connessione del backend).
--
--   authenticator : ruolo LOGIN NOINHERIT, è l'utente del DATABASE_URL del backend
--     (postgres://authenticator:...@pgbouncer:6432/...). Non ha privilegi propri sulle
--     tabelle: ottiene tutto SOLO dopo `SET LOCAL ROLE authenticated`. Per poterlo
--     fare deve essere MEMBRO di anon/authenticated/service_role → GRANT ... TO
--     authenticator in fondo.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- bypassrls: canale di servizio (seed/admin) che ignora la RLS. NON va esposto
    -- al runtime del browser; usato solo da script server-side come owner/servizio.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    -- LOGIN: è l'utente del connection string del backend.
    -- NOINHERIT: i privilegi arrivano solo via SET ROLE esplicito.
    -- PASSWORD: NON impostata qui. Va impostata fuori da questo file, una tantum,
    --   leggendola da una variabile d'ambiente (segreto), p.es.:
    --     ALTER ROLE authenticator WITH PASSWORD '...';   -- da Railway var, non in git
    --   oppure via psql:  ALTER ROLE authenticator PASSWORD :'AUTHENTICATOR_PASSWORD';
    -- Lasciare il ruolo senza password lo rende inutilizzabile per il LOGIN finché
    -- non viene impostata (fail-safe: nessuna password di default committata).
    create role authenticator login noinherit;
  end if;
end
$$;

-- authenticator può assumere SOLO i due ruoli applicativi runtime (membership).
-- Idempotente: GRANT role TO role è no-op se la membership esiste già.
--
-- LEAST PRIVILEGE: service_role NON è concesso ad authenticator. Il canale di
-- servizio (auth.* , seed/admin, bypassrls) è raggiungibile SOLO dalla connessione
-- di servizio dedicata (AUTH_DB_URL / DATABASE_URL_DIRECT, ruolo owner/service),
-- mai dal pool runtime del backend che si connette come authenticator. Così, anche
-- se il path `authenticated` fosse forzato, non potrebbe escalare a service_role né
-- leggere auth.staff_users / auth.refresh_tokens.
grant anon, authenticated to authenticator;

-- search_path stabile per le sessioni `authenticated`: con pgbouncer in
-- transaction-mode il search_path non è garantito tra transazioni, e le SELECT
-- dirette del backend (role authenticated, soggette a RLS) si aspettano `public`.
-- Le 14 RPC hanno già `set search_path = public` esplicito; questo copre le SELECT.
alter role authenticated set search_path = public, pg_temp;

-- ----------------------------------------------------------------------------
-- 2) SCHEMA auth + funzioni auth.uid()/auth.role()/auth.jwt()
--
-- Identiche allo shim CI (supabase/ci/prelude.sql): leggono i claims iniettati nella
-- sessione via current_setting('request.jwt.claims'). Il backend, per ogni richiesta
-- autenticata, fa `select set_config('request.jwt.claims', <json>, true)` dentro la
-- tx (vedi lib/db.ts::withAuth) — esattamente come PostgREST. La forma dei claims è
-- fissa: ospite { sub }, staff { sub, app_metadata: { role } }.
--
-- auth.uid() fa il CAST a uuid del claim `sub`: il backend DEVE garantire che `sub`
-- sia un UUID valido (crypto.randomUUID()), altrimenti il cast esplode.
-- ----------------------------------------------------------------------------
create schema if not exists auth;

-- Le funzioni auth.* devono essere risolvibili anche dalle SELECT `authenticated`
-- (le RPC le richiamano tramite app_role()/is_staff() che stanno in public).
grant usage on schema auth to anon, authenticated, service_role;

-- auth.uid(): UUID dell'utente corrente, dal claim `sub`. NULL se non autenticato
-- (fail-safe verso meno privilegi). Supporta sia il claim flat
-- `request.jwt.claim.sub` (compat PostgREST) sia il JSON `request.jwt.claims`.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

-- auth.role(): il ruolo Postgres effettivo del chiamante è sempre `authenticated`
-- nel nostro pattern (lo shim Supabase ritorna la costante; manteniamo la parità).
create or replace function auth.role() returns text language sql stable as $$
  select 'authenticated';
$$;

-- auth.jwt(): l'intero set di claims come jsonb (oggetto vuoto se assente).
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- Le funzioni auth.* devono essere eseguibili dai ruoli applicativi.
grant execute on function auth.uid()  to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant execute on function auth.jwt()  to anon, authenticated, service_role;
