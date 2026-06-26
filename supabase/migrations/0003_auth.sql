-- ============================================================================
-- TOTEM NIGHT — 0003_auth.sql
-- Storage dell'auth propria (sostituisce GoTrue). Vive nello schema DEDICATO
-- `app_auth` (creato qui). NON usiamo lo schema `auth`: in prod quello è di
-- GoTrue/Supabase (auth.users, auth.refresh_tokens, ...) e le NOSTRE tabelle
-- collidono. Queste tabelle sono il backing store del modulo lib/auth-server:
-- credenziali staff + refresh token opachi (con rotazione/revoca).
--
-- SICUREZZA — accesso ESCLUSIVO al ruolo di servizio/owner:
--   * NESSUN grant a `authenticated` o `anon`. Il browser non deve MAI poter leggere
--     password_hash o token_hash, nemmeno via RLS. Queste tabelle non sono toccate
--     dal data-access layer `authenticated`: ci accede solo lib/auth-server con una
--     connessione di servizio/owner (postgres, AUTH_DB_URL) FUORI dalla tx
--     `set role authenticated`.
--   * Di default, una tabella appena creata in `app_auth` (di proprietà di postgres)
--     non è accessibile ad anon/authenticated: non concediamo nulla, quindi resta negata.
--   * Niente RLS qui: la protezione è "nessun grant", non una policy. (anon/authenticated
--     non hanno alcun privilegio → non possono nemmeno tentare la SELECT.)
--
-- NB: le funzioni auth.uid()/auth.role()/auth.jwt() restano nello schema `auth`
-- (definite in 0000_prelude.sql): NON sono toccate da questa migrazione.
--
-- Va applicato dopo 0000_prelude.sql (richiede pgcrypto). Owner = chi applica (postgres).
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- Schema dedicato per l'auth propria di Totem Night (separato da `auth` di GoTrue).
create schema if not exists app_auth;

-- ----------------------------------------------------------------------------
-- app_auth.staff_users — credenziali dello staff (cassa/regia/admin).
--   id            : UUID dell'utente staff = `sub` del JWT emesso al login.
--   email         : login. Normalizzato a lower(trim) lato app (lookupStaffForLogin
--                   e l'insert di seed devono salvare/cercare sempre in minuscolo).
--   password_hash : hash della password (argon2id, calcolato da lib/auth-server).
--   role          : claim app_metadata.role; vincolato ai tre valori legali.
--   disabled_at   : se valorizzato, l'account è disabilitato → lookupStaffForLogin
--                   lo esclude (`disabled_at is null`) e il login fallisce 401.
-- Gli OSPITI NON stanno qui: hanno solo un JWT anonimo con `sub` UUID fresco,
-- nessun account (register_guest crea la riga in public.guests on-the-fly).
-- ----------------------------------------------------------------------------
create table if not exists app_auth.staff_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text not null,
  role          text not null check (role in ('cassa','regia','admin')),
  disabled_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- Unicità + lookup case-insensitive: l'email è univoca a meno del case (gli
-- indirizzi sono case-insensitive di fatto). L'indice funzionale su lower(email)
-- è ANCHE l'indice usato da lookupStaffForLogin (where lower(email) = $1).
create unique index if not exists staff_users_email_lower_idx
  on app_auth.staff_users (lower(email));

-- ----------------------------------------------------------------------------
-- app_auth.refresh_tokens — refresh token OPACHI con rotazione e revoca.
--   token_hash  : SHA-256 (hex) del token opaco; il token in chiaro vive solo nel
--                 cookie HttpOnly del client, MAI nel DB (così un dump del DB non
--                 espone token utilizzabili).
--   sub         : a chi appartiene (id staff_users, o UUID ospite anonimo).
--   role        : ruolo da rimettere nel nuovo access token al refresh (NULL = ospite).
--   issued_at   : emissione del token (default now()); usato da lib/auth-server/refresh.ts.
--   expires_at  : scadenza assoluta del refresh.
--   revoked_at  : se valorizzato, il token è morto (logout / kill-all per sub).
--   replaced_by : alla rotazione, punta al nuovo token (rileva il riuso di un token
--                 ruotato → segnale di furto, si può fare kill-all per il sub).
-- ----------------------------------------------------------------------------
create table if not exists app_auth.refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  sub         uuid not null,
  role        text,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  replaced_by uuid references app_auth.refresh_tokens (id)
);

-- Verifica del token presentato al refresh (UNIQUE crea già l'indice; esplicito).
create index if not exists refresh_tokens_token_hash_idx on app_auth.refresh_tokens (token_hash);
-- Revoca/enumerazione per utente (kill-all per sub al logout-globale o sospetto furto).
create index if not exists refresh_tokens_sub_idx on app_auth.refresh_tokens (sub);

-- NB: nessun GRANT. Accesso solo via connessione di servizio/owner (postgres, AUTH_DB_URL).
