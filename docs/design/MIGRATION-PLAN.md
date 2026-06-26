# Totem Night — Piano di migrazione backend

> 2026-06-26. Supabase self-hosted → **Postgres plugin Railway + Next.js API routes + auth JWT propria + realtime LISTEN/NOTIFY** (pattern abituale dell'utente). Prodotto da workflow multi-agente (data/RPC ∥ auth ∥ realtime → plan-architect). NON ancora eseguito.

# Totem Night — MIGRATION-PLAN.md

**Da:** Supabase self-hosted (Kong + GoTrue + PostgREST + Realtime + Postgres) — 6 servizi.
**A:** pattern abituale dell'utente su Railway EU West — **Next.js (UI + API routes) + Postgres plugin + pgbouncer + auth JWT propria + LISTEN/NOTIFY→SSE**.

**Tesi (verificata leggendo il codice).** Lo *strato sicuro* dell'app — schema, 14 RPC `SECURITY DEFINER`, RLS default-deny, grants, 29 contract/RLS test — è **Postgres puro**. `tests/db.mjs::actAs` (righe 125-142) è già la prova vivente: apre `begin`, `set local role authenticated`, `set_config('request.jwt.claims', <json>, true)`, chiama la RPC → riproduce **byte per byte** ciò che fa PostgREST. Migriamo solo il **bordo**: emissione token (auth propria al posto di GoTrue), trasporto (API routes al posto di supabase-js), realtime (NOTIFY→SSE al posto di Supabase Realtime). Il **nucleo non si tocca**.

Verificato sui file reali:
- `supabase/ci/prelude.sql` — `auth.uid()` legge già `request.jwt.claims->>'sub'`, `auth.jwt()`/`auth.role()` shim presenti. Oggi marcato "shim per CI": **va promosso a migrazione di produzione** (su Postgres vanilla lo schema `auth` di Supabase non esiste).
- `lib/rpc.ts` / `lib/auth.ts` — firme da preservare (`registerGuest`, `topup`, `lookupGuestByPin`, `RpcError`, `GuestRow`, `STAFF_ROLES`, `isStaffRole`); cambia solo il **corpo** (da `supabase.rpc`/`.from` a `fetch('/api/...')`).
- `tests/db.mjs::setup()` — i fixture girano da owner con `reset role` (righe 64-117); conferma il modello "ruolo di servizio fuori dalla tx authenticated".
- `supabase/migrations/` — convenzione `NNNN_nome.sql` (oggi `0001_init.sql`, `0002_draws_select_staff.sql`). I nuovi step seguono la stessa numerazione.

---

## A) Architettura target (diagramma a parole)

```
                              Railway — progetto "totem-night" (EU West)
 ┌──────────────┐   HTTPS    ┌───────────────────────────────────────────────┐
 │   browser    │──────────► │  SERVIZIO 1: Next.js (UI + api-gateway)        │
 │  (PWA guest/ │  cookie    │  • UI: /onboarding /guest /cassa /regia        │
 │   cassa/regia)│ HttpOnly  │  • API routes:                                 │
 └──────────────┘            │     /api/auth/*  (anon, login, refresh, me,    │
        ▲                    │                   logout)  ← auth JWT propria  │
        │ SSE (text/event-   │     /api/rpc/:fn (14 RPC via withAuth)         │
        │  stream)           │     /api/guest/[id] (read RLS-scoped)          │
        └────────────────────│     /api/stream/* (SSE da LISTEN/NOTIFY)       │
                             │  • lib/db.ts  withAuth()  ── pool pg ──┐       │
                             │  • lib/sse/listener.ts (1 LISTEN diretto)──┐   │
                             └────────────────────────────────────────┼──┼──┘
                                          pg (pool, tx-mode)           │  │ LISTEN
                                                    │                  │  │ (bypassa
                                                    ▼                  │  │  pgbouncer)
                                       ┌─────────────────────┐         │  │
                                       │ SERVIZIO 2: pgbouncer│◄────────┘  │
                                       │  transaction pooling │            │
                                       └──────────┬───────────┘            │
                                                  ▼                        │
                                       ┌─────────────────────┐             │
                                       │ SERVIZIO 3: Postgres │◄────────────┘
                                       │   plugin (autoritativo)            │
                                       │  schema public.* + auth.*          │
                                       │  prelude + 0001 + 0002 + 0003/0004 │
                                       │  ruolo authenticator (LOGIN)       │
                                       └─────────────────────┘
```

**Tre regole architetturali che governano tutto:**
1. **Il backend non re-implementa MAI l'autorizzazione.** Verifica il JWT, estrae i claims `{sub, app_metadata:{role}}`, li inoltra `as-is` a `withAuth`. RLS + `is_staff()`/`auth.uid()` decidono nel DB. Identico al modello PostgREST. Il gate `requireRole` nelle route è solo UX/difesa-in-profondità.
2. **Ogni accesso DB autenticato = una tx corta a singola istruzione** (`begin; set local role authenticated; set_config(...,true); SELECT rpc(); commit`). `set_config(...,true)` e `SET LOCAL` sono **local-to-tx** → compatibili con pgbouncer transaction-mode, nessun leak di identità tra richieste.
3. **Realtime = trigger, refetch = autoritativo.** `pg_notify` porta solo un id; il client rilegge la riga via API RLS-scoped. Già il contratto di `useGuestState.ts` oggi ("il payload non include `ticket_totali` generated → rileggo sempre"). Rende lo strato realtime lossy-tolerant: una notifica persa ritarda un refetch, non corrompe lo stato.

---

## B) Mappa di riuso

| Componente | Esito | % riuso | Note |
|---|---|---|---|
| `0001_init.sql` (tabelle, CHECK, indici, GENERATED, FK) | **RIUSATO** | 100% | applicato tale e quale come migrazione Railway |
| RLS policies (`*_select`, default-deny) | **RIUSATO** | 100% | dipendono da `auth.uid()`/`is_staff()` → entrambi disponibili via prelude+claims |
| 14 RPC `SECURITY DEFINER` (body) | **RIUSATO** | 100% | zero modifiche; girano come owner, leggono `current_setting` |
| Helper `app_role`/`is_staff`/`totem_level`/`current_event` | **RIUSATO** | 100% | invariati |
| Grants `to authenticated` | **RIUSATO** | 100% | `authenticator` li eredita via membership dopo `SET ROLE` |
| `supabase/ci/prelude.sql` (`auth.uid/role/jwt`) | **PROMOSSO** | — | da "shim CI" a migrazione di prod (`0000_prelude.sql`). +1 riga: ruolo `authenticator` |
| `0002_draws_select_staff.sql` | **RIUSATO** | 100% | applicato dopo 0001 |
| `tests/db.mjs` (harness `actAs`/`setup`) | **RIUSATO** | ~95% | cambia solo `DATABASE_URL`→authenticator via pgbouncer; `actAs` È il prototipo di `withAuth` |
| `register_guest`/`topup`/`rls.test.mjs` (29 test) | **RIUSATO** | ~100% | non sanno nulla di Supabase → regression-set canonico del nuovo backend |
| `lib/rpc.ts` (firme + `RpcError`/`GuestRow`) | **RISCRITTO (corpo)** | firma 100% | `supabase.rpc`→`fetch('/api/rpc/...')`; le pagine non cambiano |
| `lib/auth.ts` (`staffSignIn`/`getSessionRole`/`signOut`; `STAFF_ROLES`/`isStaffRole`) | **RISCRITTO (corpo)** | costanti 100% | →`POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` |
| `lib/events.ts` (`getCurrentEventId`) | **RISCRITTO/SERVER-SIDE** | firma ~ | risolto server-side nelle route (meno round-trip, già auspicato in rpc.ts:100-102) |
| `lib/useGuestState.ts` (`UseGuestStateResult`) | **RISCRITTO (trasporto)** | interfaccia 100% | `postgres_changes`→`EventSource` + refetch; logica loading/error/proiezione invariata |
| `lib/guest-session.ts` (`localStorage` guestId) | **RIUSATO** | 100% | il guestId è un puntatore non-segreto; il token vive nei cookie HttpOnly |
| `lib/supabase/{client,server,middleware}.ts` + `middleware.ts` + `@supabase/ssr` | **ELIMINATO** | 0% | →`lib/api.ts` (fetch+cookie) + middleware refresh JWT custom |
| `e2e_supabase.test.mjs`, `cassa_e2e.test.mjs` (supabase-js) | **RISCRITTO** | 0% | →e2e HTTP (`fetch` su `/api/*`); logica asserita identica |
| `lib/db.ts` (`withAuth`) | **NUOVO** | — | ~30 righe = `actAs` con `commit` |
| `lib/auth-server/` (firma/verifica JWT, hash pw, refresh) | **NUOVO** | — | `jose` + `argon2` |
| `0003_auth.sql` (`auth.staff_users`, `auth.refresh_tokens`) | **NUOVO** | — | `public.*` non si tocca |
| `0004_notify.sql` (2 trigger NOTIFY) | **NUOVO** | — | additivo, RPC body invariati |
| `app/api/**` (14 RPC + auth + stream + guest read) | **NUOVO** | — | gli endpoint |
| `lib/sse/listener.ts` + `/api/stream/*` | **NUOVO** | — | LISTENer singleton + SSE |

**Sintesi onesta:** ~70% del *valore tecnico* (schema/RPC/RLS/contract-test) è riuso a costo zero. Il lavoro vero è ~30%: auth propria (la parte più densa), 16 route, 2 trigger + listener SSE, riscrittura test e2e.

---

## C) Fasi → step (strangler: backend nuovo affianca, Supabase spento per ULTIMO)

**Principio strangler.** Si tiene Supabase **acceso e wired** finché ogni nuovo pezzo non è verificato. Il DB Postgres nuovo nasce in parallelo, l'app punta al vecchio finché non si fa il cutover atomico per-strato. Ogni step lascia l'app **funzionante e rollback-abile**.

Effort: **S** ≈ ≤0.5gg · **M** ≈ 0.5–1.5gg · **L** ≈ 1.5–3gg.

### FASE 0 — DB su Railway (fondamenta, zero impatto sull'app live)
- **0.1 — Provision (S).** Postgres plugin + pgbouncer (transaction-mode) su Railway EU West, rete privata. **DoD:** `psql` come `postgres` ok; pgbouncer raggiungibile sulla 6432.
- **0.2 — Schema + prelude promosso (M).** Applica come `postgres`, in ordine: `create extension pgcrypto` → `0000_prelude.sql` (auth.* + ruoli) → `0001_init.sql` → `0002_draws_select_staff.sql`. Crea `authenticator LOGIN NOINHERIT` + `GRANT authenticated TO authenticator`. Owner RPC = ruolo dedicato `totem_definer` (o `postgres` come fallback). `ALTER ROLE authenticated SET search_path = public, pg_temp`. **DoD:** schema applicato senza errori; `\df auth.*` mostra `uid/role/jwt`.
- **0.3 — Verifica nucleo (M).** Punta `tests/db.mjs` a `DATABASE_URL=postgres://authenticator:...@pgbouncer:6432/railway`, gira i **29 contract/RLS test**. **DoD (gate di "schema migrato bene"): tutti passano invariati.** Se passano qui, il nucleo è migrato. È il checkpoint più importante del piano.

### FASE 1 — Auth propria (lo strato applicativo nuovo, in parallelo)
- **1.1 — Schema auth (S).** `0003_auth.sql`: `auth.staff_users` (id, email unique, password_hash argon2id, role check in cassa/regia/admin) + `auth.refresh_tokens` (token_hash sha256, sub, role, expires/revoked/replaced_by). Accessibili solo dal ruolo di servizio, mai da `authenticated`. **DoD:** tabelle create, seed di 1 staff di test.
- **1.2 — Modulo auth-server (L).** `lib/auth-server/`: firma/verifica JWT (`jose`, HS256, secret in var Railway), hash/verify pw (`argon2`), emissione access (`{sub}` o `{sub,app_metadata:{role}}`, TTL 10-15min) + refresh opaco (rotazione). **DoD:** unit test: firma/scadenza, rotazione refresh, revoca, rifiuto claim manomesso.
- **1.3 — Endpoint auth (M).** `/api/auth/anon` (POST, rate-limited, `sub`=randomUUID, JWT anonimo, **niente role**→`app_role()='guest'`), `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/me`. Cookie HttpOnly+Secure+SameSite=Lax (`tn_at`/`tn_rt`). **DoD:** curl: anon→token; login staff→token con role; refresh ruota; me→{role}. Vincolo: `sub` **UUID valido** (auth.uid() fa cast a uuid, altrimenti esplode).

### FASE 2 — Data-access layer + 14 RPC come API routes (in parallelo, non ancora wired)
- **2.1 — `lib/db.ts` withAuth (S).** Pool pg → pgbouncer; `withAuth(claims, fn)` = `actAs` con `commit`. **DoD:** test che chiama `topup` via `withAuth` e committa (la riga persiste).
- **2.2 — 14 endpoint RPC (L).** `app/api/rpc/:fn` (o route per-RPC). Pipeline: verifica JWT → `requireRole` (UX) → `withAuth(claims, c => c.query('select * from public.<rpc>(...)'))`. Coprire tutte e 14 (le 3 wired oggi — register_guest, topup, current_event — + le 11 dormienti per regia/cassa futura). **DoD:** ogni RPC raggiungibile; gli stessi input dei contract test danno gli stessi output.
- **2.3 — Read-through RLS (M).** `GET /api/guest/[id]` (policy self-or-staff) e `GET /api/cassa/guest?pin=` (lookup staff). Ogni GET = una SELECT dentro `withAuth`. **DoD:** ospite legge solo la propria riga; staff legge per pin; cross-guest → vuoto/403 (RLS).

### FASE 3 — Cutover client (lo swap, un trasporto per volta)
- **3.1 — `lib/api.ts` + riscrittura wrapper (M).** `apiGet`/`apiPost` (`credentials:'include'`). Riscrivi il **corpo** di `lib/rpc.ts`/`auth.ts`/`events.ts` mantenendo le firme. **DoD:** typecheck verde; `RpcError`/`GuestRow`/`STAFF_ROLES` invariati → le pagine non cambiano.
- **3.2 — Onboarding + cassa (M).** `app/onboarding`: `signInAnonymously`→`POST /api/auth/anon`. `app/cassa`: `createClient`→`lib/api.ts`; la macchina a stati (gate ruolo, idemRef, lookup, topup) **non cambia**. **DoD:** flusso ospite (anon→register→saldo) e cassa (login→lookup→topup idempotente) verdi end-to-end contro il **DB nuovo**.
- **3.3 — Middleware refresh JWT (S).** Sostituisci `middleware.ts` Supabase con refresh sliding (se `tn_at` scaduto e `tn_rt` valido → refresh + ri-set cookie). **DoD:** sessione sopravvive alla scadenza dell'access token.

### FASE 4 — Realtime (lo step più economico, ultimo prima del cutover finale)
- **4.1 — Trigger NOTIFY (S).** `0004_notify.sql`: `AFTER UPDATE ON public.guests`→`pg_notify('guest_state', {guest_id})`; `AFTER UPDATE OF fase ON public.events`→`pg_notify('event_phase', {event_id, fase})`. **Nessun trigger su `taps`** (anti-burst). RPC body invariati. **DoD:** test: `topup` committato emette esattamente 1 notify con guest_id giusto e **senza pin/saldi**; RPC rollbackata emette 0.
- **4.2 — LISTENer + SSE (M).** `lib/sse/listener.ts`: **1 connessione pg diretta** (bypassa pgbouncer — LISTEN muore in transaction-mode), `LISTEN guest_state; LISTEN event_phase`, registry `Map<subId,res>`, reconnect+re-LISTEN con backoff. `/api/stream/guest?guest=X` (SSE, `runtime='nodejs'`): authz (caller==X o staff) → filtra `guest_state` per guest_id → forward → keep-alive `:` ogni 15s. **DoD:** due browser, due ospiti: ognuno riceve solo i propri eventi; topup di X → solo X refetcha.
- **4.3 — Swap useGuestState (S).** `supabase.channel(postgres_changes)`→`new EventSource('/api/stream/guest?guest='+id)` + refetch su `state`/`phase`/`onopen`/`visibilitychange`. `fetchRow`→`fetch('/api/guest/'+id)`. Interfaccia `UseGuestStateResult` invariata. **DoD:** `/guest` e `/cassa` aggiornano in tempo reale senza toccare le pagine. **Alternativa MVP:** polling 2-3s (dimezza la complessità; SSE come step 2 se serve).
- **4.4 — Regia (M, opzionale MVP).** `/api/stream/regia` (event_phase, staff-only) + stats via **polling aggregato 1.5s** durante fasi tap (NO realtime per-tap). Risolve i `TODO(realtime)` in `app/regia`.

### FASE 5 — Cutover finale + spegnimento Supabase (irreversibile per ultimo)
- **5.1 — E2E HTTP (M).** Riscrivi `e2e_supabase`/`cassa_e2e` come fetch su `/api/*`. **DoD:** register→topup→read RLS→idempotenza verdi via HTTP. Nuovi test auth (rotazione, revoca, rifiuto claim manomesso, rate-limit anon).
- **5.2 — Soak in parallelo (S).** Tieni Supabase acceso ma scollegato dal traffico (env già su DB nuovo). Verifica una serata di test / smoke. **DoD:** nessun riferimento residuo a `@supabase/*` nel bundle (grep).
- **5.3 — Rimozione dipendenze (S).** Disinstalla `@supabase/ssr`, `@supabase/supabase-js`; `pg` da dev→dep; aggiungi `jose`, `argon2`. Elimina `lib/supabase/*`. **DoD:** build/typecheck/test verdi senza Supabase.
- **5.4 — Spegnimento Railway (S).** Rimuovi i 6 servizi Supabase (vedi §G). **DoD:** restano web + Postgres + pgbouncer; app live verde.

**Sequenza di cutover (riassunto):** DB nuovo verde (0.3) → auth pronta (1) → API pronte (2) → client swappato sul DB nuovo (3) → realtime swappato (4) → e2e + spegnimento (5). Supabase è l'ultima cosa che muore.

---

## D) Impatto sui test

**Restano invariati (gate di regressione del nucleo) — i 29 contract/RLS:**
- `tests/db.mjs` (harness `actAs`/`setup`) — solo `DATABASE_URL`→authenticator.
- `register_guest.test.mjs`, `topup.test.mjs`, `rls.test.mjs` — parlano a Postgres puro, ignari di Supabase. Diventano il regression-set canonico. **Eseguirli alla Fase 0.3 È il gate "schema migrato bene".**

**Da riscrivere (e2e, accoppiati a supabase-js):**
- `e2e_supabase.test.mjs` — usa `createClient` + `auth.admin.createUser` (service_role). →`fetch` su `/api/auth/*` + `/api/rpc/*`. La sequenza asserita (register→topup→RLS read→idempotenza) resta identica.
- `cassa_e2e.test.mjs` — idem, contro `/api/cassa/*` + `/api/auth/login`.

**Nuovi test da aggiungere:**
- Auth: verifica firma/scadenza JWT, rotazione refresh, revoca (kill-all per sub), **rifiuto claim manomesso** (browser che tenta `app_metadata.role:'admin'` → impossibile, claim firmato server-side), rate-limit `/api/auth/anon`.
- Realtime: `topup`/`consume` committato → esattamente 1 NOTIFY `guest_state` con guest_id giusto e **nessun pin/saldo** nel payload; RPC rollbackata → 0 NOTIFY.

---

## E) Rischi + rollback per step

| Step | Rischio | Mitigazione | Rollback |
|---|---|---|---|
| 0.2 | prelude NON applicato prima di 0001 → RPC non trovano `auth.uid()` | ordine fisso pgcrypto→prelude→0001→0002; oppure inline le 3 funzioni in 0001 | re-applica prelude; idempotente (`create or replace`) |
| 0.2 | owner RPC = `authenticator` → DEFINER diventa no-op (bypass RLS perso) | owner = `totem_definer` dedicato (o postgres), MAI authenticator | re-owner `ALTER FUNCTION ... OWNER TO totem_definer` |
| 0.3 | contract test rossi → schema non equivalente | è il gate: NON proseguire finché non passano | resta su Supabase, nessun impatto live |
| 1.3 | `sub` non-UUID → `auth.uid()` cast esplode | genera `sub=crypto.randomUUID()` sempre | n/a (bug bloccante in dev) |
| 2.x | pgbouncer + prepared statements in transaction-mode | disabilita prepared lato pg, **o** pgbouncer ≥1.21 (prepared a livello protocollo). **DA VERIFICARE versione** | abbassa a session-mode temporaneo (ma rompe run_draw `setseed` + temp table → preferire fix) |
| 2.x | pool app > capacità pgbouncer sotto burst | `Pool({max:10-20})`/replica ≤ pgbouncer default_pool_size; tx corte | scala pgbouncer; throttle |
| 3.2 | regressione UX cutover client | strangler: Supabase ancora acceso, feature-flag env per puntare vecchio/nuovo | flip env → torna a Supabase |
| 4.1 | NOTIFY perde pin/saldi nel payload (leak) | payload = solo id; refetch RLS-scoped autoritativo | rimuovi trigger (additivo, drop sicuro) |
| 4.2 | LISTEN via pgbouncer muore | connessione **diretta** al Postgres plugin per il LISTENer; RPC restano su pgbouncer | fallback a **polling 2-3s** (zero infra realtime) |
| 4.2 | >6 SSE/origin su HTTP/1.1 | 1 EventSource per schermata; Railway serve HTTP/2 (cap rimosso) | polling |
| 4.x | burst tap (register_taps, ~12/s/ospite) | **nessun trigger su taps**; throttle client POST a 1-4/s (RPC idempotente sul cumulativo); leaderboard = poll 1.5s | n/a (by design) |
| 5.x | service_role spariscono → creazione staff | seed/CLI server-side come `postgres` (non serve ruolo bypassrls esposto) | re-seed |
| 5.4 | spegnimento Supabase prematuro | spegnere SOLO dopo soak verde (5.2) e grep `@supabase` pulito | ri-deploy stack Supabase (template Railway) |

**Rollback globale:** finché non si esegue 5.4, ogni fase è reversibile via env (puntare l'app al vecchio backend). Lo spegnimento dei 6 servizi è l'unico passo irreversibile e arriva ultimo, dopo soak.

---

## F) Stima totale realistica + timing

| Fase | Effort |
|---|---|
| 0 — DB su Railway | M+M+M ≈ **1.5–2.5 gg** |
| 1 — Auth propria | S+L+M ≈ **2.5–4 gg** (parte più densa/rischiosa) |
| 2 — DAL + 14 RPC API | S+L+M ≈ **2.5–4 gg** |
| 3 — Cutover client | M+M+S ≈ **1.5–2.5 gg** |
| 4 — Realtime SSE (o polling) | S+M+S(+M) ≈ **1.5–3 gg** (polling MVP taglia ~1 gg) |
| 5 — E2E + spegnimento | M+S+S+S ≈ **1–2 gg** |
| Buffer integrazione/imprevisti (~20%) | **+1.5–3 gg** |
| **TOTALE** | **≈ 11–18 giornate-uomo** |

**Range onesto: 11-18 gg.** Verso 11 se: si sceglie **polling invece di SSE** per l'MVP, si riusa **as-is l'auth-service aegis** esistente (opzione B, evita di scrivere `lib/auth-server` da zero), e non emergono sorprese pgbouncer/prepared. Verso 18 se: auth propria scritta ex-novo (HS256→eventuale RS256), SSE completo + regia realtime, e debug pgbouncer.

**Raccomandazione timing: DOPO l'evento, mai prima/durante.**
- È una migrazione del bordo a basso rischio **tecnico** ma ad alta superficie di cutover (auth + 16 route + realtime). Non vale rischiare una serata live.
- Lo strangler permette di costruire e verificare tutto **in parallelo** a Supabase ancora acceso: il lavoro non blocca un evento, ma il **cutover finale** (Fase 3+) va fatto in una finestra calma.
- Se c'è un evento imminente: fermarsi alla **Fase 0.3** (DB nuovo verificato in parallelo, gate superato) e rimandare 1-5 a dopo. Zero rischio sull'evento, e si è già de-risk-ato la parte che conta (equivalenza del nucleo).

---

## G) Cosa fare su Railway

**Stato finale: da ~7 servizi a 3.**

**Rimuovere (6 servizi Supabase self-host):**
1. Kong (API gateway Supabase)
2. GoTrue (auth) — sostituito da `lib/auth-server` + `auth.staff_users`/`refresh_tokens`
3. PostgREST — sostituito dalle API routes Next (`withAuth`)
4. Realtime — sostituito da LISTEN/NOTIFY→SSE (o polling)
5. Storage / altri sidecar Supabase (se presenti) — non usati dall'app
6. Studio / Meta (se deployati) — solo tooling

**Restano (3 servizi):**
1. **Next.js** (web = UI + api-gateway + auth + SSE) — l'unico servizio applicativo
2. **Postgres plugin** (autoritativo: `public.*` + `auth.*` + prelude + ruolo `authenticator`)
3. **pgbouncer** (transaction pooling per RPC/read; il LISTENer SSE lo bypassa con connessione diretta)

**Variabili Railway (sul servizio Next):**
- `DATABASE_URL` → `postgres://authenticator:...@<pgbouncer>:6432/railway` (RPC/read)
- `DATABASE_URL_DIRECT` → `postgres://...@<postgres-plugin>:5432/railway` (solo LISTENer SSE, bypassa pgbouncer)
- `JWT_SECRET` (access, HS256) — mai nel bundle client
- `JWT_REFRESH_SECRET` o refresh opachi in DB (consigliato: opachi → revoca immediata)
- rimuovere: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

**Ordine operativo su Railway:** provisiona Postgres+pgbouncer e costruisci il nuovo backend **accanto** allo stack Supabase (entrambi vivi). Sposta il traffico via env. Spegni i 6 servizi Supabase **solo** in 5.4, dopo soak verde.

**Memo sicurezza (da MEMORY.md `rotate-shared-credentials`):** la `service_role` key Supabase e le credenziali condivise in chat vanno **ruotate/dismesse** al cutover — con auth propria spariscono dal browser (solo cookie HttpOnly) e dal runtime (creazione staff = seed CLI come `postgres`).

---

## Punti aperti da decidere (segnalati, non risolti)
1. **JWT anonimo ospite:** l'auth-service aegis gestisce già un path "token anonimo con sub UUID"? Se no, è l'unico flusso auth nuovo da aggiungere (register_guest resta invariata purché sub sia UUID).
2. **Monolite vs auth-service dedicato (aegis):** (A) modulo `lib/auth-server` dentro Next — consigliato per evento singolo (meno hop/superficie); (B) auth-service Railway dedicato — se vuoi riusare aegis as-is/condividere staff tra progetti (allora valuta RS256/EdDSA per verificare con sola chiave pubblica).
3. **pgbouncer + prepared statements:** confermare versione/config per il driver `pg` in transaction-mode (≥1.21 o disabilitare prepared).
4. **SSE vs polling per l'MVP:** per un evento singolo con poche centinaia di ospiti, polling 2-3s è un ponte legittimo e taglia ~1 gg; LISTEN/NOTIFY+SSE come step 2.
5. **Owner SECURITY DEFINER:** ruolo dedicato `totem_definer` (più pulito) vs `postgres` (funziona). Mai `authenticator`.
6. **Replica count del backend Next:** decide quanti LISTENer diretti (ognuno riceve ogni NOTIFY e fa fan-out ai propri SSE). Default assunto: 1-2 repliche.

---

## Appendice A — Analisi DATA/RPC

# Totem Night — Migrazione backend DA Supabase self-hosted VERSO pattern Railway (Postgres plugin + Next.js API routes + auth JWT propria + LISTEN/NOTIFY). LENTE DATA/RPC.

## TL;DR (la tesi regge, con un caveat)

L'intuizione e' **corretta**: schema + 14 RPC + RLS + grants + i contract test sono **plain Postgres** e si **riusano interi**. Il file `tests/db.mjs` e' gia' la prova vivente: apre una tx, fa `set local role authenticated`, `set_config('request.jwt.claims', <json>, true)`, poi chiama le RPC/SELECT — e' **identico** a cio' che il nuovo backend Node deve fare a runtime. PostgREST non fa magia: traduce HTTP -> `SET ROLE` + `set_config(jwt.claims)` + `SELECT rpc(...)`. Replichiamo quei 3 passi in un handler Next.

**Caveat #1 (l'unico vero lavoro DB di adattamento):** lo schema dipende da `auth.uid()` e `auth.jwt()` nello schema `auth`. In Supabase esistono; su Postgres vanilla NO. La soluzione esiste gia' ed e' testata: `supabase/ci/prelude.sql` ricrea `auth.uid()/role()/jwt()` come funzioni che leggono `current_setting('request.jwt.claims')`. **Quel prelude diventa una migrazione di produzione** (oggi e' solo "shim CI"). Zero righe di `0001_init.sql` cambiano.

**Caveat #2 (realtime):** `postgres_changes` su `guests` (Supabase Realtime, via replica logica) sparisce. Va sostituito con `LISTEN/NOTIFY` Postgres -> SSE. Richiede ~3 trigger DB nuovi (NOTIFY) + 1 endpoint SSE. E' l'unica parte "nuova" lato DB.

**% riuso:** schema tabelle/RLS/grants **100%** | 14 RPC **100%** (zero modifiche al body) | contract test (`tests/db.mjs`, register_guest/topup/rls) **~95%** (cambia solo da dove arriva `DATABASE_URL`) | e2e supabase-js **0%** (riscrivere contro le API routes) | `auth.*` helper passa da shim-CI a oggetto di produzione.

---

## 1) Pattern del backend a runtime (mappa esatta PostgREST -> Next API route)

### 1.1 Il contratto di sessione DB per ogni richiesta autenticata
Ogni handler API che tocca il DB con identita' utente esegue, **in una singola transazione**, esattamente cio' che fa `actAs()` in `tests/db.mjs:125`:

```
BEGIN;
SET LOCAL ROLE authenticated;                                  -- ruolo "client" (mai owner)
SELECT set_config('request.jwt.claims', $1::text, true);       -- $1 = JSON claims, local-to-tx
-- una sola istruzione di lavoro:
SELECT * FROM <rpc>(...);   -- oppure  SELECT <cols> FROM <tabella> WHERE ...  (soggetta a RLS)
COMMIT;
```

Note critiche:
- `set_config(..., true)` -> **local alla transazione**: con pgbouncer transaction-mode la connessione viene riciclata a fine tx e il claim **non sopravvive** ad altri client. E' il comportamento che vogliamo (no leak di identita' tra richieste). E' anche perche' PostgREST usa lo stesso `set_config(local)`.
- `SET LOCAL ROLE authenticated` -> idem, ripristinato a COMMIT/ROLLBACK. Il ruolo di **connessione** resta `authenticator` (vedi sezione 2).
- I claims hanno la forma **esatta** gia' fissata dai test (`tests/db.mjs:42-50`): ospite `{ sub }`; staff `{ sub, app_metadata: { role: 'cassa'|'regia'|'admin' } }`. `app_role()` (schema riga 26) e `auth.uid()` (prelude riga 10) leggono da li'. **Non cambia una virgola del contratto claims.**

### 1.2 Helper backend (il "PostgREST nostro", ~30 righe)
```ts
// lib/db.ts (server-only)
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: <vedi sez.4> });

export async function withAuth<T>(claims: object, fn: (c: PoolClient)=>Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) { await c.query('rollback').catch(()=>{}); throw e; }
  finally { c.release(); }
}
```
E' letteralmente `actAs()` con `commit` al posto del `rollback` finale. **Riuso concettuale 1:1 dai test.**

### 1.3 Mappa RPC -> endpoint (le 14 RPC; chiamante; claims)
"WIRED oggi" = gia' chiamata dal client attuale. Il grep conferma: il client usa solo `register_guest`, `topup`, `current_event`, e la SELECT `guests` per pin/realtime. Le altre 11 RPC sono in schema+test ma non ancora nel front-end.

| # | RPC | Endpoint proposto | Metodo | Chiamante | Gate (claims) | Wired oggi |
|---|-----|-------------------|--------|-----------|---------------|-----------|
| 0 | current_event() | GET /api/event/current | GET | ospite+staff | qualunque auth | si (lib/events.ts) |
| 1 | register_guest(p_event,p_nome) | POST /api/guest/register | POST | ospite | {sub} | si (lib/rpc.ts) |
| 2 | topup(p_guest,p_tipo,p_qta,p_importo,p_idem) | POST /api/cassa/topup | POST | cassa | role in {cassa,admin} | si (lib/rpc.ts) |
| 3 | consume(p_guest,p_drink,p_idem) | POST /api/cassa/consume | POST | cassa | staff | no |
| 4 | convert_credit(p_guest,p_idem) | POST /api/credit/convert | POST | ospite o staff | self-or-staff | no |
| 5 | set_phase(p_event,p_phase) | POST /api/regia/phase | POST | regia | role in {regia,admin} | no |
| 6 | start_session(p_event,p_durata) | POST /api/regia/session/start | POST | regia | regia | no |
| 7 | register_taps(p_session,p_count) | POST /api/tap | POST | ospite | {sub} | no |
| 8 | close_session(p_session) | POST /api/regia/session/close | POST | regia | regia | no |
| 9 | run_draw(p_event,p_n_winners,p_seed) | POST /api/regia/draw | POST | regia | regia | no |
| 10 | update_event_settings(...9 param...) | POST /api/regia/settings | POST | regia | regia | no |
| 11 | upsert_drink(...) | POST /api/regia/drink | POST | regia | regia | no |
| 12 | set_drink_visibility(p_drink,p_visibile) | PATCH /api/regia/drink/visibility | PATCH | regia | regia | no |
| 13 | set_drink_active(p_drink,p_attivo) | PATCH /api/regia/drink/active | PATCH | regia | regia | no |
| 14 | delete_drink(p_drink) | DELETE /api/regia/drink | DELETE | regia | regia | no |

Handler-tipo (vale per tutte e 14):
```ts
// app/api/cassa/topup/route.ts
export async function POST(req) {
  const claims = await requireRole(req, ['cassa','admin']);   // sez.3: verifica JWT proprio
  const { guestId, tipo, qta, importo, idem } = await req.json();
  const row = await withAuth(claims, c =>
    c.query('select * from public.topup($1,$2,$3,$4,$5)',
            [guestId, tipo, qta, importo, idem ?? randomUUID()]).then(r=>r.rows[0]));
  return Response.json(row);
}
```
Nota: il gate `requireRole` e' **UX/difesa-in-profondita'**, non la sicurezza vera. Anche con un claim sbagliato la RPC fa `if not is_staff() then raise` (es. `topup` riga 303) e il DB rigetta. La sicurezza resta **server-authoritative nel DB**, come oggi.

### 1.4 Le SELECT lette dal client (RLS, NON RPC)
Il client attuale fa 2 SELECT dirette (soggette a RLS). Diventano GET che fanno la stessa SELECT dentro `withAuth`:

| SELECT attuale | dove | Endpoint | RLS applicata |
|----------------|------|----------|---------------|
| guests per id (fetch+realtime) | lib/useGuestState.ts:86 | GET /api/guest/:id | guests_select (riga 207): self-or-staff |
| guests per event_id+pin | lib/rpc.ts:109 (lookupGuestByPin) | GET /api/cassa/guest?pin= | guests_select (solo staff la usa) |

Tabelle leggibili via policy _select (schema 199-222), da esporre come GET read-through quando regia/guest le useranno: `events`, `drinks` (filtro `visibile OR is_staff`), `transactions` (self-or-staff), `tap_sessions`, `taps` (self-or-staff), `draws`. **Ogni GET = una SELECT dentro withAuth(claims)**: la RLS decide cosa torna, zero autorizzazione duplicata nel backend.

> Punto chiave: il backend non re-implementa MAI l'autorizzazione. Inoltra i claims, il DB (RLS + is_staff()/auth.uid()) decide. Identico al modello PostgREST.

---

## 2) Gestione ruoli DB (chi si connette, grants, owner SECURITY DEFINER)

### 2.1 Ruolo di connessione = authenticator (nuovo, da aggiungere)
Oggi `prelude.sql` crea `anon`, `authenticated`, `service_role` ma **NON** `authenticator` (in CI il pool si connette come owner e fa `set local role`). In produzione non vogliamo connetterci come owner. Pattern PostgREST replicato:
- Creare ruolo **authenticator** `LOGIN`, `NOINHERIT`, password forte (e' l'utente del connection string del backend).
- `GRANT authenticated TO authenticator;` (e `anon` se servira' un path pre-login server-side).
- `authenticator` non ha privilegi propri sulle tabelle: ottiene tutto **solo** dopo `SET ROLE authenticated`. E' cio' che lo rende sicuro come ruolo di connessione esposto.

`DATABASE_URL` del backend -> `postgres://authenticator:...@<pgbouncer-host>:6432/railway`.

> Su Railway: il Postgres plugin da' l'utente `postgres` (superuser). Si crea `authenticator` con una migrazione/one-off; il backend NON usa la URL `postgres` di default ma quella di `authenticator`. (Pattern gia' presente nei 4 progetti dell'utente con auth-service custom.)

### 2.2 Grants — gia' nello schema, riusabili
Lo schema (righe 787-813) concede gia' a `authenticated`: `usage on schema public`; `select` su tutte e 7 le tabelle (le scritture dirette restano negate -> solo RLS SELECT); `execute` su tutte e 14 RPC + helper. Poiche' `authenticator` eredita `authenticated` via membership (dopo SET ROLE), **questi grant bastano cosi'**. Nessun nuovo grant applicativo. (Non creare `service_role` runtime se non serve un canale bypass-RLS; oggi serve solo ai test e2e supabase-js per l'Admin API.)

### 2.3 Owner delle SECURITY DEFINER
- Le 14 RPC sono SECURITY DEFINER -> girano **come il loro owner**, bypassando la RLS internamente (e' il punto: l'ospite non puo' scrivere `guests` direttamente, ma `topup` si' perche' gira come owner).
- **Owner consigliato:** ruolo dedicato non-login `totem_definer` (o owner di schema), **MAI** `authenticator` (altrimenti un definer diventa no-op). Su Railway, applicando lo schema come `postgres`, l'owner di default e' `postgres` (superuser): funziona ma e' meglio un owner dedicato meno privilegiato. Ogni funzione ha gia' `set search_path = public` (es. riga 249) -> mitiga search-path hijack. Gli helper `app_role/is_staff/totem_level` sono INVOKER (default) e vanno bene: leggono `current_setting` del chiamante.
- `current_event()` e' INVOKER e dipende da `events_select` (RLS, to authenticated) -> richiede sessione `authenticated`. OK col pattern.

---

## 3) Auth propria — cosa emette i claims (l'unico pezzo applicativo nuovo)

Supabase Gotrue spariscono. L'auth-service custom dell'utente (gia' in produzione su 4 progetti) emette un JWT con almeno `sub` e — per lo staff — `app_metadata.role`. Il backend: (1) verifica firma; (2) estrae `{ sub, app_metadata: { role } }`; (3) lo passa **as-is** a `withAuth(claims, ...)`.

Mapping ai due tipi di sessione odierni:
- **Ospite** = oggi `signInAnonymously()` (onboarding/page.tsx:38). Sostituto: l'auth-service emette un **JWT anonimo** con `sub` UUID fresco. Niente `role` -> `app_role()` ritorna `'guest'` (schema riga 33). `register_guest` legge `auth.uid()=sub` e crea la riga. **Nessuna modifica alla RPC.**
- **Staff** = oggi `signInWithPassword` + claim `app_metadata.role` via Admin API (e2e_supabase.test.mjs:83). Sostituto: login email/pw contro l'auth-service che mette `role` nel JWT. `is_staff()` (riga 38) lo legge. **Nessuna modifica.**

> Implicazione DB: `auth.uid()` di prelude legge `request.jwt.claims->>'sub'` e fa **cast a uuid** (prelude riga 17). Garantire che `sub` sia un **UUID valido**, altrimenti `auth.uid()` esplode. La FK/unique `guests.auth_uid` (righe 96,110) continua a mappare 1:1 all'utente.

Service-role / bypass RLS: oggi usato solo dai test e2e (Admin API createUser). In produzione il setup evento/staff (creare evento, assegnare ruoli) puo' girare con connessione `postgres` (owner) in uno script di seed/admin: **non serve un ruolo bypassrls esposto al runtime**.

---

## 4) Rischi DB e mitigazioni (burst tap = scenario di carico critico)

### 4.1 Connection pool sotto burst tap — rischio #1
- `register_taps` (riga 516) e' chiamata **da ogni ospite, ripetutamente** durante una finestra tap (`durata_s` default 30, `max_tap_al_secondo` default 12). E' il path a piu' alto QPS dell'app.
- **pgbouncer transaction-mode obbligatorio** (l'utente lo ha gia'). Il pattern `BEGIN; set local; set_config; SELECT rpc; COMMIT` e' una **tx corta a singola istruzione** -> ideale per transaction-mode (connessione restituita al pool a fine tx).
- **Vincolo transaction-mode:** niente prepared statements server-side persistenti, niente SET non-local tra tx. I nostri `set_config(..., true)`/`SET LOCAL` sono local-to-tx -> compatibili. Configurare `pg` con `statement_timeout`; verificare gestione prepared statements lato pgbouncer (disabilitarli o pgbouncer >=1.21 con prepared a livello protocollo). **DA VERIFICARE** la versione.
- **Dimensionamento pool** (`new Pool({ max })`): il pool applicativo deve essere <= cio' che pgbouncer accetta lato client; pgbouncer multiplexa su poche connessioni server reali. Tipico: backend max 10-20 per replica, pgbouncer default_pool_size 20-40 verso Postgres. Il burst genera richieste **brevi** -> throughput limitato dalla latenza per-tx, non dalle connessioni aperte.
- **Mitigazione gia' nello schema:** `register_taps` scrive **un solo upsert idempotente** su `taps` con `tap_count` cumulativo monotono (`least/greatest`, righe 548-551). Il client puo' **throttlare** il POST /api/tap (es. inviare il count ogni 250-500ms, 1-4 req/s/ospite invece di 12) — la RPC e' idempotente sul cumulativo, perdere update intermedi non perde ticket. **Raccomandazione forte:** throttle client -> ~10x meno QPS senza toccare il DB.

### 4.2 Contesa di lock
- `topup`/`consume`/`convert_credit` fanno `SELECT ... FOR UPDATE` sulla riga `guests` (righe 318, 361, 416). Per-ospite -> contesa solo se due cassieri toccano lo **stesso** ospite insieme (raro). Nessun hot-row globale. OK.
- `close_session` (riga 560) fa FOR UPDATE sulla sessione + loop su tutti i taps: **una** chiamata regia a fine sessione, non sul path caldo. Tenere `statement_timeout` generoso per quell'endpoint (loop+insert per ogni ospite puo' durare).
- `run_draw` (riga 601) usa `create temporary table _pool on commit drop` + `setseed`: **compatibile con transaction-mode** perche' la temp table vive nella stessa tx (`on commit drop`) e `setseed` e' session-state local alla tx d'esecuzione. **Si romperebbe** con pgbouncer statement-mode; transaction-mode e' fine.

### 4.3 search_path / current_setting
- `current_setting('request.jwt.claims', true)`: il `true` (missing_ok) evita errore se non settato (helper riga 31, prelude riga 25). **Garantire** che il backend setti SEMPRE i claims prima di toccare il DB; se non li setta, `app_role()` -> 'guest' e `auth.uid()` -> NULL (fail-safe verso **meno** privilegi). Buono.
- **search_path:** le RPC DEFINER hanno `set search_path = public` esplicito. Le SELECT del backend girano come `authenticated`: pgbouncer non garantisce search_path tra tx -> impostarlo a livello ruolo (`ALTER ROLE authenticated SET search_path = public, pg_temp;`) o nel BEGIN.
- **pgcrypto/gen_random_uuid():** lo schema fa `create extension if not exists pgcrypto` (riga 19). Su Railway l'estensione e' disponibile; eseguirla una volta come `postgres` all'applicazione dello schema.

### 4.4 Realtime LISTEN/NOTIFY -> SSE (sostituisce postgres_changes)
- Oggi `useGuestState` (righe 111-130) si abbona a `postgres_changes` su `guests` (`id=eq.<guestId>`) e ad ogni evento **rilegge** la riga (il payload non porta la colonna GENERATED `ticket_totali`). Questo design "evento = solo trigger, poi re-fetch" e' **perfetto per NOTIFY**: payload minimale (solo guest_id), il client rilegge via GET /api/guest/:id.
- **Lavoro DB nuovo (~3 trigger):** `AFTER UPDATE ON guests` (dove cambia saldo/ticket: topup, consume, convert_credit, close_session) -> `pg_notify('guest_changed', NEW.id::text)`. Opzionale per `events` (cambio fase) e `tap_sessions` (regia). NOTIFY e' transazionale: scatta solo a COMMIT della RPC. **Le RPC non vanno modificate** se si usa un trigger AFTER UPDATE (preferibile a un `perform pg_notify` dentro ogni RPC).
- **Trasporto / vincolo architetturale:** `LISTEN` e' session-state e **non passa da pgbouncer transaction-mode** (morirebbe). Design corretto: **un singolo canale globale** `guest_changed` con payload `{guest_id}`; **una sola connessione LISTEN diretta a Postgres per istanza di backend** (bypass pgbouncer), un processo che mantiene la mappa guestId->client SSE e fa il routing in-process. NON una connessione LISTEN per ospite, NON wildcard (NOTIFY non le supporta). Endpoint `GET /api/guest/:id/stream` (SSE, `export const runtime='nodejs'`, no edge).
- **Alternativa MVP:** polling leggero (GET /api/guest/:id ogni 2-3s). Per un evento singolo con poche centinaia di ospiti il costo e' trascurabile e dimezza la complessita' della prima release; LISTEN/NOTIFY+SSE come step 2.

---

## 5) Cosa NON cambia (riuso, in dettaglio)

| Artefatto | Riuso | Note |
|-----------|-------|------|
| 0001_init.sql (tabelle, CHECK, indici, GENERATED, FK) | **100%** | applicare tale e quale come migrazione Railway |
| RLS policies (righe 190-222) | **100%** | dipendono da auth.uid()/is_staff(); entrambi disponibili via prelude+claims |
| 14 RPC SECURITY DEFINER (body) | **100%** | zero modifiche; girano come owner, leggono current_setting |
| Helper app_role/is_staff/totem_level/current_event | **100%** | invariate |
| Grants to authenticated (righe 787-813) | **100%** | authenticator li eredita via membership |
| auth.uid/role/jwt (prelude.sql) | **promosso** | da "shim CI" a oggetto di produzione (1 migrazione) |
| tests/db.mjs harness | **~95%** | il pattern actAs E' il pattern di prod; serve solo DATABASE_URL->authenticator e prelude applicato in prod |
| register_guest/topup/rls.test.mjs (29 test) | **~100%** | girano gia' contro Postgres reale, non sanno nulla di Supabase. Restano la suite di regressione DB |
| e2e_supabase.test.mjs, cassa_e2e.test.mjs (supabase-js) | **0%** | da riscrivere come e2e HTTP contro le API routes (fetch al posto di supabase.rpc) |
| lib/rpc.ts, lib/events.ts, lib/auth.ts | **interfaccia ~riusabile** | mantenere le firme (registerGuest, topup, lookupGuestByPin, getCurrentEventId, staffSignIn); cambiare il **corpo** da supabase.rpc/from a fetch('/api/...'). Il front-end non cambia se le firme restano |
| lib/supabase/*, middleware.ts, @supabase/ssr | **eliminati** | sostituiti da client fetch + cookie JWT proprio + middleware refresh JWT custom |
| useGuestState.ts | **~80%** | logica fetch+proiezione identica; cambia solo il trasporto realtime: supabase.channel(postgres_changes) -> EventSource('/api/guest/:id/stream') o polling. Il "re-fetch su evento" resta uguale |

---

## 6) Ordine di esecuzione consigliato (piano, NON eseguito)

1. **DB su Railway:** Postgres plugin + pgbouncer (transaction-mode). Applicare come postgres: pgcrypto, **prelude.sql promosso** (auth.* + ruoli), 0001_init.sql, 0002_draws_select_staff.sql. Creare ruolo `authenticator LOGIN` + `GRANT authenticated TO authenticator`. Owner RPC = ruolo dedicato o postgres.
2. **Verifica DB:** puntare tests/db.mjs (DATABASE_URL=authenticator via pgbouncer), far girare i 29 contract/RLS test -> devono passare **invariati**. Gate di "schema migrato bene".
3. **Auth-service:** emissione JWT {sub} (ospite anon) e {sub,app_metadata.role} (staff) + verifica firma nel backend.
4. **API routes:** lib/db.ts (withAuth) + i 14 endpoint RPC + i GET read-through (guests, drinks, ...). Riscrivere il corpo di lib/rpc.ts/events.ts/auth.ts mantenendo le firme.
5. **Realtime:** trigger NOTIFY + endpoint SSE (o polling MVP) + swap in useGuestState.
6. **E2E:** riscrivere e2e_supabase/cassa_e2e come e2e HTTP. Eliminare dipendenze @supabase/*.

## 7) Aperti da decidere (segnalati, non risolti)
- **JWT anonimo ospite:** l'auth-service custom gestisce gia' login con password? Serve un path "token anonimo con sub UUID" nuovo. (register_guest resta invariata purche' sub sia UUID.)
- **pgbouncer + prepared statements:** confermare versione/config per il driver pg in transaction-mode.
- **SSE vs polling per l'MVP:** per un evento singolo, polling 2-3s e' un ponte legittimo; LISTEN/NOTIFY+SSE come step 2.
- **Owner SECURITY DEFINER:** ruolo dedicato vs postgres (entrambi funzionano; dedicato e' piu' pulito).

## File analizzati (path assoluti)
- /Users/ciofani/Desktop/TotemNight/totem-night/docs/totem-night_db_schema.sql (schema v0.2 autoritativo: 14 RPC + RLS + grants)
- /Users/ciofani/Desktop/TotemNight/totem-night/supabase/ci/prelude.sql (shim auth.* da promuovere a prod)
- /Users/ciofani/Desktop/TotemNight/totem-night/tests/db.mjs (harness pg = pattern di prod, riusabile)
- /Users/ciofani/Desktop/TotemNight/totem-night/lib/rpc.ts, lib/events.ts, lib/auth.ts (firme da preservare, corpo da riscrivere)
- /Users/ciofani/Desktop/TotemNight/totem-night/lib/useGuestState.ts (realtime postgres_changes -> SSE/polling)
- /Users/ciofani/Desktop/TotemNight/totem-night/lib/supabase/{client,server,middleware}.ts, middleware.ts (da eliminare)
- /Users/ciofani/Desktop/TotemNight/totem-night/app/onboarding/page.tsx (anon sign-in da sostituire), tests/e2e_supabase.test.mjs (da riscrivere HTTP)

## Appendice B — Analisi AUTH

# Migrazione Auth: GoTrue → auth propria (stile aegis) — Totem Night

**Ruolo:** @integration-specialist (lente AUTH). Piano, **non eseguito**. Niente file scritti.

## 0. Tesi portante (confermata dalla lettura del codice)

Le 14 RPC `SECURITY DEFINER` + RLS + grants sono **Postgres puro**. Tre punti di contatto con Supabase, e solo tre:

1. **Identità** — le RPC leggono `auth.uid()` e `app_role()`, che a loro volta leggono `current_setting('request.jwt.claims')` (vedi `register_guest` riga 254, `register_taps` riga 523, `app_role()` righe 26-35). In Supabase è PostgREST a iniettare quel setting dal JWT GoTrue.
2. **Trasporto** — il browser oggi parla con PostgREST via `supabase-js` (`supabase.rpc(...)`, `supabase.from('guests').select()`).
3. **Realtime** — `useGuestState.ts` usa `postgres_changes` (Supabase Realtime → WAL logical replication).

Il file **`tests/db.mjs` è già la prova vivente** del piano: si connette come ruolo `authenticated`, fa `set_config('request.jwt.claims', {sub, app_metadata:{role}}, true)` dentro una tx e chiama le RPC ottenendo **esattamente** il comportamento di PostgREST (incluse RLS sulle SELECT dirette). Il backend Next farà la stessa identica cosa per ogni richiesta, dentro una tx per-richiesta.

**Conseguenza:** schema + RPC + RLS + i contract-test `db.mjs`/`register_guest`/`topup`/`rls` **si riusano integri**. Cambiano solo: emissione JWT (auth propria al posto di GoTrue), trasporto (API routes al posto di supabase-js), realtime (LISTEN/NOTIFY→SSE al posto di Supabase Realtime). `prelude.sql` (lo shim `auth.uid()`/`auth.jwt()`/`auth.role()`, righe 3-26) **smette di essere "solo per la CI": diventa parte dello schema di produzione**, perché in prod non c'è più lo schema `auth` di Supabase.

---

## 1. Architettura target su Railway (EU West)

Replica il pattern abituale dell'utente (api-gateway + auth-service custom + Postgres plugin + pgbouncer):

```
[browser]──HTTPS──►[ Next.js app (api-gateway + UI) ]──pg──►[ pgbouncer ]──►[ Postgres plugin ]
                          │  - API routes /api/*                 (transaction      (schema v0.2
                          │  - auth interna (modulo, vedi sotto)   pooling)          + prelude come prod)
                          │  - SSE /api/stream (LISTEN/NOTIFY)
                          └─ env: JWT secret, DB url, pgbouncer url
```

Servizi Railway:
- **Postgres plugin** — autoritativo; ci giri `prelude.sql` (ruoli + schema auth shim) **PRIMA** di `0001_init.sql`/`0002`. Già esiste come migrazione, va solo promosso a prod-prelude.
- **pgbouncer** — pooling. **Attenzione `set_config(..., true)` + transaction pooling**: il `true` = scope `LOCAL` alla transazione → compatibile con pgbouncer in transaction mode SOLO se ogni richiesta apre `BEGIN ... COMMIT/ROLLBACK` e fa `SET LOCAL ROLE authenticated` + `set_config(..., true)` dentro la stessa tx. NON usare `SET` di sessione (perderesti il binding al rilascio della connessione). `db.mjs` già fa esattamente questo (`actAs`, righe 125-142) → quel pattern è la firma del data-access layer di produzione.
- **Next.js app** — un solo servizio che fa da api-gateway + UI. L'utente potrebbe volere un **auth-service** separato (stile aegis): vedi §2 nota "monolite vs servizio dedicato".

JWT secret, DATABASE_URL (via pgbouncer), refresh-secret → variabili Railway. Nessuna `service_role` key e nessun JWT firmabile lato browser.

---

## 2. Auth propria — i due flussi

### Claim shape (INVARIANTE — già fissato, non inventarlo)
Lo schema legge **esattamente** questa forma (da `app_role()` righe 30-34 e `auth.uid()` shim righe 10-18):

```jsonc
// OSPITE anonimo  → app_role()='guest', is_staff()=false
{ "sub": "<uuid>" }
// STAFF cassa      → is_staff()=true, is_staff('regia')=false
{ "sub": "<uuid>", "app_metadata": { "role": "cassa" } }
// STAFF regia/admin→ is_staff('regia')=true / admin passa sempre
{ "sub": "<uuid>", "app_metadata": { "role": "regia" } }  // o "admin"
```

Questi claim sono **la stessa forma** che `tests/db.mjs` usa in `guestClaims/cassaClaims/regiaClaims` (righe 42-50). Il JWT applicativo DEVE produrre questo `request.jwt.claims` (o un superset: campi extra sono innocui, le funzioni leggono solo `sub` e `app_metadata.role`). **Tenere il claim identico = zero modifiche a schema/RPC/RLS/contract-test.**

### 2.1 OSPITE anonimo (sostituisce `signInAnonymously`)
Sostituisce `app/onboarding/page.tsx` righe 36-40.

Flusso:
1. Browser → `POST /api/auth/anon` (nessun body, o solo CSRF).
2. Backend genera `sub = crypto.randomUUID()`, emette:
   - **access token** (JWT, claim `{ sub }`, **niente** `app_metadata` → `app_role()` ritorna `'guest'`), TTL breve (10–15 min).
   - **refresh token** opaco (random 32B), persistito in tabella `auth.refresh_tokens` (vedi §3) con `sub`, `expires_at`, `revoked_at`.
3. Token consegnati come **cookie HttpOnly + Secure + SameSite=Lax** (access `tn_at`, refresh `tn_rt`). Mai accessibili da JS → niente leak del PIN/token (R-12).
4. Il browser poi chiama `POST /api/rpc/register_guest { nome }` (il backend risolve `current_event()` server-side, come fa già `lib/rpc.ts` riga 60). `register_guest` legge `auth.uid()=sub` e crea/ritorna la riga `guests` (idempotente, righe 261-265).

L'ospite anonimo è **stateless lato server** finché non fa `register_guest`: il `sub` nel JWT È l'identità. Coincide 1:1 col modello Supabase anonymous.

### 2.2 STAFF email/password (sostituisce `signInWithPassword`)
Sostituisce `lib/auth.ts` `staffSignIn` (righe 20-30) e `getSessionRole` (righe 36-41).

Flusso:
1. `POST /api/auth/login { email, password }`.
2. Backend: `select id, password_hash, role from auth.staff_users where email=$1`; verifica con **argon2id** (o bcrypt — allinea ad aegis). Su match emette access JWT con `{ sub: staff.id, app_metadata: { role: staff.role } }` + refresh token come sopra.
3. `role ∈ {cassa,regia,admin}` è **server-authoritative**: vive nella colonna `staff_users.role`, finisce nel claim, e **non è modificabile dal client** (come oggi: il commento in `lib/auth.ts` righe 2-4 lo dichiara già).
4. `GET /api/auth/me` → ritorna `{ role }` dal JWT verificato lato server. Sostituisce `getSessionRole` (oggi `supabase.auth.getUser()`).

**Importante (gating doppio):** la pagina cassa (righe 107-117) fa già "login riuscito ≠ è staff": dopo il login richiama `getSessionRole`. Il nuovo `/api/auth/login` può direttamente **rifiutare** un utente senza ruolo staff (la tabella `staff_users` contiene solo staff), ma manteniamo `GET /api/auth/me` per il re-check al mount (riga 87) → la logica di pagina resta invariata.

### Login + refresh + revoca
- **refresh:** `POST /api/auth/refresh` legge cookie `tn_rt`, cerca il token in `auth.refresh_tokens`, verifica non-scaduto/non-revocato, **rotazione** (revoca il vecchio, emette nuovo refresh + nuovo access). Rotazione = mitigazione replay.
- **revoca:** `POST /api/auth/logout` → `update auth.refresh_tokens set revoked_at=now() where token_hash=$1` + clear cookie. Sostituisce `supabase.auth.signOut()` (`lib/auth.ts` riga 44, usato in `cassa/page.tsx` righe 113/168). Revoca staff "kill all sessions" = `update ... where sub=$staff_id`.

### Nota: monolite vs auth-service dedicato
Il pattern aegis dell'utente ha un **auth-service separato**. Due opzioni:
- **(A) modulo `lib/auth-server/` dentro l'app Next** (consigliato per Totem Night, deploy a evento singolo, meno superficie/latenza). Le API routes `/api/auth/*` vivono nell'app.
- **(B) auth-service Railway dedicato** che emette/verifica JWT; l'app Next lo chiama. Più vicino ad aegis ma +1 hop e +1 deploy. Scegli (B) solo se vuoi **riusare aegis as-is** o condividere staff tra più progetti.
In entrambi i casi **il JWT secret è condiviso** tra chi firma e chi verifica; con HS256 è un secret simmetrico (vedi §4).

---

## 3. Schema auth aggiuntivo (migrazione `0003_auth.sql`, idempotente)

Da aggiungere **dentro lo stesso Postgres**, schema `auth` (così lo shim `auth.uid()` convive). Lo schema applicativo `public.*` **non si tocca**.

```sql
-- staff: fonte di verità del ruolo (claim app_metadata.role NON editabile dal client)
create table if not exists auth.staff_users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,                       -- argon2id
  role          text not null check (role in ('cassa','regia','admin')),
  created_at    timestamptz not null default now(),
  disabled_at   timestamptz
);

-- refresh token opachi (hash, mai in chiaro), rotazione + revoca
create table if not exists auth.refresh_tokens (
  token_hash  text primary key,                      -- sha256(refresh) — mai il valore in chiaro
  sub         uuid not null,                         -- = staff_users.id, oppure uuid ospite anonimo
  role        text,                                  -- null per ospite
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  replaced_by text                                   -- catena di rotazione (audit)
);
create index if not exists idx_rt_sub on auth.refresh_tokens(sub);
```

`auth.refresh_tokens` è accessibile **solo** dal ruolo di servizio del backend (owner/migrazione), **mai** dal ruolo `authenticated`: nessuna RLS necessaria perché non viene mai interrogato con `request.jwt.claims` settato — è il backend "fuori dalla tx authenticated" a gestirlo (come `db.mjs` fa il setup da owner, righe 64-117).

---

## 4. Mapping JWT → claims Postgres (il cuore)

Per ogni richiesta autenticata che tocca il DB, il data-access layer fa (riusa il pattern `actAs` di `db.mjs` righe 125-142, ma con **COMMIT** sulle scritture invece di rollback):

```js
// pseudocodice del layer db (lib/db.ts) — una connessione dal pool pgbouncer
async function withAuth(claims, fn) {            // claims = { sub, app_metadata:{role} } | { sub }
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');                       // ← identico a db.mjs
    await c.query("select set_config('request.jwt.claims', $1, true)",    // ← LOCAL alla tx (pgbouncer-safe)
                  [JSON.stringify(claims)]);
    const out = await fn(c);                       // chiama la RPC o la SELECT RLS
    await c.query('commit');                       // ROLLBACK solo nei test
    return out;
  } catch (e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}
```

Pipeline completa di una richiesta:
1. **verifica JWT** (firma + scadenza) sul cookie `tn_at` → ottieni `claims` (`{sub}` o `{sub,app_metadata:{role}}`).
2. `withAuth(claims, c => c.query('select * from public.topup($1,$2,$3,$4,$5)', [...]))`.
3. Postgres esegue la RPC: `auth.uid()` legge `sub`, `app_role()` legge `app_metadata.role` → **comportamento identico a PostgREST/GoTrue**, byte per byte.

Il JWT applicativo e il `request.jwt.claims` Postgres **condividono la forma del claim** ma sono due cose: il primo è firmato/verificato dal backend (trasporto sicuro browser↔backend); il secondo è solo un setting di sessione DB iniettato dal backend fidato. **Il browser non vede mai `request.jwt.claims` e non può iniettarlo.**

---

## 5. Sicurezza

- **Firma:** HS256 (secret simmetrico in var Railway `JWT_SECRET`) è sufficiente per monolite/auth-service singolo. Passa a **RS256/EdDSA (asimmetrico)** se adotti l'auth-service dedicato (opzione B §2) e vuoi che l'app verifichi con la sola chiave **pubblica** senza poter firmare. Allinea alla scelta di aegis.
- **Secret in var Railway**, mai nel bundle client. Distinte: `JWT_SECRET` (access), `JWT_REFRESH_SECRET` o token opachi per il refresh (consigliato: refresh **opaco** in DB, non JWT → revoca immediata).
- **Niente service-role nel browser:** oggi il browser ha la `anon key` (innocua: RLS+RPC proteggono). Nel target il browser ha **solo cookie HttpOnly** con access/refresh: non può firmare nulla, non può bypassare RLS. La vecchia `service_role` key (usata in `e2e_supabase.test.mjs` riga 56 per Admin API) **sparisce**: la creazione staff diventa una migration/CLI server-side.
- **Durata token:** access 10–15 min (TTL breve = blast radius minimo se rubato dai DevTools — ma è HttpOnly), refresh 8–24h (durata di una serata) con **rotazione** ad ogni uso. A fine evento: revoca di massa per `sub`.
- **Anonymous abuse (R-12):** il `POST /api/auth/anon` è non autenticato → rate-limit per IP (es. token bucket in memoria/Redis, o tabella). Mitiga la creazione massiva di ospiti. Nota: oggi `register_guest` genera un PIN univoco per evento con retry (righe 268-278) e l'unique `(event_id, pin)` è la garanzia finale → un ospite "vuoto" senza `register_guest` non occupa nemmeno una riga `guests`. Il PIN **non va broadcastato** in realtime (commento schema riga 7/97): con SSE per-guest (§6) questo è naturale perché ogni ospite riceve solo la **propria** riga.
- **CSRF:** con cookie HttpOnly servono `SameSite=Lax` + (per le mutation) header anti-CSRF o `Origin` check sulle API routes.

---

## 6. Realtime: `postgres_changes` → LISTEN/NOTIFY → SSE

Fuori dalla lente auth ma incide su `useGuestState.ts` (righe 111-130) e sui cookie auth dello stream. Sintesi:
- Trigger Postgres `after update on public.guests` → `pg_notify('guest:'||NEW.id, '')` (payload vuoto, **mai il PIN/saldi nel canale**: si rilegge la riga via RLS, esattamente come fa oggi `fetchRow` righe 83-105 perché il payload non includeva `ticket_totali` generated).
- `GET /api/stream/guest` (SSE): verifica JWT (cookie), apre **una connessione DB dedicata** che fa `LISTEN "guest:<sub→guest.id>"`; su notify → manda un evento SSE; il client rifà la `GET /api/guest/me` (SELECT RLS).
- `useGuestState` perde `supabase.channel(...).on('postgres_changes')` e diventa `new EventSource('/api/stream/guest')` + refetch via API. La forma del risultato (`UseGuestStateResult`) non cambia → le pagine non si toccano.

---

## 7. Cosa cambia lato client (mapping puntuale al codice attuale)

| File attuale | Oggi (Supabase) | Target (auth propria + API) |
|---|---|---|
| `lib/supabase/client.ts` | `createBrowserClient(anon)` | **eliminato** → `lib/api.ts`: `fetch` con `credentials:'include'` (cookie HttpOnly), wrapper `apiPost/apiGet` |
| `lib/supabase/server.ts` | `createServerClient` (cookie SSR) | **eliminato** → in route handler si legge/verifica il JWT dai cookie |
| `lib/supabase/middleware.ts` + `middleware.ts` | `supabase.auth.getUser()` per refresh sessione | refresh sliding: se `tn_at` scaduto e `tn_rt` valido → chiama internamente refresh e ri-setta i cookie. Stessa responsabilità, altra implementazione |
| `lib/auth.ts` | `signInWithPassword` / `getUser().app_metadata.role` / `signOut` | `staffSignIn`→`POST /api/auth/login`; `getSessionRole`→`GET /api/auth/me`; `signOut`→`POST /api/auth/logout`. **`STAFF_ROLES`/`isStaffRole` (righe 9-15) restano identici** |
| `lib/rpc.ts` | `supabase.rpc('register_guest'/'topup')`, `supabase.from('guests').select()` | `apiPost('/api/rpc/register_guest', {nome})`, `apiPost('/api/rpc/topup', {...})`, `apiGet('/api/guest?pin=')`. **`RpcError`/`GuestRow`/firme restano identici** → le pagine non cambiano |
| `lib/events.ts` | `supabase.rpc('current_event')` | risolto **server-side** dentro le API routes (il client non lo chiama più → meno round-trip, già auspicato nel commento riga 100-102 di `rpc.ts`) |
| `lib/useGuestState.ts` | `postgres_changes` channel | `EventSource('/api/stream/guest')` + refetch (vedi §6) |
| `lib/guest-session.ts` | `localStorage` solo `guestId` | **invariato** (il guestId resta un puntatore; il token vive nei cookie HttpOnly, NON in localStorage) |
| `app/onboarding/page.tsx` (righe 33-48) | `signInAnonymously` + `registerGuest` | `POST /api/auth/anon` → `apiPost('/api/rpc/register_guest')`. Resto della pagina invariato |
| `app/cassa/page.tsx` (righe 44, 87, 106-117, 138-195) | `createClient()` + supabase auth/rpc | `lib/api.ts` + nuovi wrapper. **La macchina a stati della pagina (gate ruolo, idemRef, lookup, topup) non cambia** perché i wrapper mantengono firma/tipi |

**Token storage (decisione):** cookie **HttpOnly+Secure+SameSite=Lax**, non localStorage. Motivo: oggi `supabase-js` usa localStorage per la sessione, ma con auth propria il cookie HttpOnly elimina l'esposizione XSS del token e abilita il refresh in middleware (SSR-friendly, come già fa il middleware Supabase). `guest-session.ts` continua a tenere solo il `guestId` (puntatore non-segreto) in localStorage.

---

## 8. Endpoint auth (riepilogo)

| Endpoint | Metodo | Auth | Funzione |
|---|---|---|---|
| `/api/auth/anon` | POST | — (rate-limited) | emette access+refresh ospite `{sub}` |
| `/api/auth/login` | POST | — | email/pw staff → access+refresh `{sub,role}` |
| `/api/auth/refresh` | POST | cookie `tn_rt` | rotazione refresh + nuovo access |
| `/api/auth/logout` | POST | cookie | revoca refresh + clear cookie |
| `/api/auth/me` | GET | cookie `tn_at` | `{ role }` (sostituisce `getSessionRole`) |
| `/api/rpc/:fn` | POST | cookie `tn_at` | proxy tipizzato alle 14 RPC via `withAuth` |
| `/api/guest` / `/api/guest/me` | GET | cookie | SELECT RLS su `guests` (lookup PIN staff / propria riga) |
| `/api/stream/guest` | GET (SSE) | cookie | LISTEN/NOTIFY → eventi realtime |

---

## 9. Riuso test (impatto minimo)

- **`tests/db.mjs` + `register_guest`/`topup`/`rls.test.mjs` (29 contract/RLS):** **invariati** — già parlano a Postgres puro col pattern target. Diventano il regression-set canonico del nuovo backend (anzi: `actAs` È il prototipo di `withAuth`).
- **`tests/e2e_supabase.test.mjs` + `cassa_e2e.test.mjs`:** vanno **riscritti** contro le API routes (sostituire `createClient(@supabase/supabase-js)` + `auth.admin.createUser` con `fetch` agli endpoint `/api/auth/*` e `/api/rpc/*`). La logica asserita (register→topup→RLS read→idempotenza) resta identica.
- **Nuovi test auth da aggiungere:** verifica firma/scadenza JWT, rotazione refresh, revoca, rifiuto claim manomesso (es. browser che tenta `app_metadata.role:'admin'` → impossibile perché il claim è firmato server-side), rate-limit `/api/auth/anon`.

---

## 10. Dipendenze e rischi

- **Da rimuovere:** `@supabase/ssr`, `@supabase/supabase-js`. **Da aggiungere:** `jose` (firma/verifica JWT), `argon2` (hash password), `pg` (già dev-dep, promuovere a dep). Lo stack Supabase self-host (Kong+GoTrue+PostgREST+Realtime) **si dismette** — resta solo Postgres.
- **Rischio #1 — pgbouncer + `set_config` LOCAL:** confermare transaction-pooling e che ogni richiesta sia incapsulata in `BEGIN…COMMIT` (mai `SET` di sessione). Se per qualche path serve una connessione "fuori tx" (es. setup), usarla solo dal ruolo di servizio.
- **Rischio #2 — `prelude.sql` in prod:** lo shim `auth.uid()/jwt()/role()` deve essere applicato in produzione **prima** di `0001_init.sql`, altrimenti le RPC non trovano `auth.uid()`. Oggi è marcato "shim per CI" → promuoverlo a migration di prod (o inlineare quelle 3 funzioni in `0001`).
- **Rischio #3 — claim drift:** qualunque modifica futura a `app_role()`/`is_staff()` deve restare compatibile con la forma `{sub, app_metadata.role}`. È l'unico contratto da congelare.
- **Invarianti garantite:** ID ospite = `guests.id` (QR), PIN univoco per evento, idempotenza su `p_idem`, anti-cheat tap server-side, estrazione riproducibile — **tutto nello schema, zero dipendenza da Supabase**.

**Bottom line:** è una migrazione del **bordo** (emissione token + trasporto + realtime), non del **nucleo** (schema/RPC/RLS/contract-test). Il rischio è basso perché `db.mjs` già dimostra che il nucleo gira identico su Postgres vanilla col claim iniettato a mano — e quel claim è la stessa cosa che la nuova auth firmerà.

## Appendice C — Analisi REALTIME

# Realtime migration plan — Supabase Realtime → Postgres LISTEN/NOTIFY + SSE

**Scope of this lens:** replace the *transport of live state* only. Schema, the 14 RPCs, RLS, and the contract tests are reused unchanged (they are plain Postgres; `tests/db.mjs` already proves a Node `pg` connection as role `authenticated` + `set_config('request.jwt.claims', …)` reproduces PostgREST behaviour). What changes: emission (`pg_notify` from triggers), fan-out (a dedicated `LISTEN` connection in the Next backend), and the client transport (`EventSource`/SSE instead of `supabase.channel().on('postgres_changes')`). Auth (own JWT) and write transport (API routes) are covered by the sibling lenses; here I assume `req` carries a verified `{sub, app_metadata:{role}}` claim that the stream endpoint can read.

---

## 0. Design constraint that shapes everything: the "notify = trigger only" rule

The existing `useGuestState.ts` already treats Realtime as a **dumb trigger**: on any event it ignores the payload and re-`SELECT`s the authoritative row (comment in the file: *"il payload di postgres_changes NON include le colonne GENERATED (ticket_totali)… quindi rileggiamo sempre la riga completa"*). We **keep this contract**. It is the single most important property to preserve:

- `pg_notify` payloads stay **minimal** (just an id + a monotonic marker), never the business numbers.
- The client, on every SSE message, calls the existing authoritative read path (an API route wrapping the same `SELECT … where id = guestId` that RLS already scopes).
- This makes the realtime layer **lossy-tolerant**: a dropped/coalesced notification only delays a refetch, never corrupts state. It also sidesteps the 8 KB `pg_notify` payload limit entirely.

So the realtime layer never has to be "correct" in the data sense — only "timely enough". That relaxes every other decision below (coalescing, reconnect, WS-vs-SSE).

---

## 1. Channels & payloads

Three logical streams, mapped to Postgres `NOTIFY` channels. Channel names are **per-tenant where the data is per-tenant** (guest) and **per-event where the data is shared** (phase, stats).

| Stream | Postgres channel | Emitted by (trigger on) | Payload (JSON, minimal) | Consumers |
|---|---|---|---|---|
| `guest:state` | `guest_state` (single channel, id in payload) | `AFTER UPDATE` on `public.guests` | `{"guest_id":"<uuid>","rev":<xmin-ish bump>}` | the one guest's `/guest`; `/cassa` for the selected guest |
| `event:phase` | `event_phase` | `AFTER UPDATE OF fase` on `public.events` | `{"event_id":"<uuid>","fase":"APERTA"}` | every client (`/guest`, `/cassa`, `/regia`) |
| `regia:stats` | `regia_stats` | coalesced (see §3) — NOT a raw per-row trigger | `{"event_id":"<uuid>"}` (ping only) | `/regia` only (staff) |

Notes on channel naming:
- **One channel `guest_state` with `guest_id` in the payload**, NOT `guest:<uuid>` as a distinct channel per guest. Reason: a single backend `LISTEN guest_state` connection (§2) demultiplexes to the right SSE subscribers in-process. `LISTEN`-ing a dynamic channel name per connected guest would mean one PG connection per guest — defeats the point. RLS is enforced at the **fan-out** layer, not by channel isolation (see §2/§5).
- `pin` is **never** put in any notify payload (schema comment on `guests.pin`: *"NON broadcastare nei realtime verso altri"*). The minimal payload makes this automatic.
- `event:phase` carries the new `fase` inline (it's tiny, public to all authenticated, and lets the client update the phase badge without a refetch — the only place a payload value is trusted, because `fase` is not security-sensitive and the client re-reads on reconnect anyway).

### Triggers to add (new DDL, additive — does not touch RPC bodies)
```sql
-- guests: bump on every write the RPCs do (topup/consume/convert_credit/register_taps→taps? no, guests only)
create or replace function public.notify_guest_state() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('guest_state',
    json_build_object('guest_id', NEW.id)::text);
  return NEW;
end $$;
create trigger trg_notify_guest_state
  after update on public.guests
  for each row execute function public.notify_guest_state();

-- events: only when fase changes
create or replace function public.notify_event_phase() returns trigger
  language plpgsql as $$
begin
  if NEW.fase is distinct from OLD.fase then
    perform pg_notify('event_phase',
      json_build_object('event_id', NEW.id, 'fase', NEW.fase)::text);
  end if;
  return NEW;
end $$;
create trigger trg_notify_event_phase
  after update on public.events
  for each row execute function public.notify_event_phase();
```
`run_draw` writes `draws` + flips `events.fase` to `ESTRAZIONE`/`CHIUSA`, so the phase trigger already covers "draw happened → screens flip". A dedicated `draw_result` notify can be added later for the winners reveal on `/regia` (out of MVP).

**Important — triggers fire per statement inside the RPC's transaction and emit on COMMIT.** `pg_notify` is transactional: the LISTENer receives it only after the RPC commits, which is exactly what we want (no notify for rolled-back `consume` that hit "saldo insufficiente").

---

## 2. Backend fan-out architecture

```
                       ┌─────────────────────────────────────────┐
  Postgres ── NOTIFY ──▶│  1 long-lived `pg` Client (the LISTENer) │
 (guest_state,          │  LISTEN guest_state;                     │
  event_phase,          │  LISTEN event_phase;                     │
  regia_stats)          │  LISTEN regia_stats;                     │
                       │  client.on('notification', dispatch)     │
                       └───────────────┬──────────────────────────┘
                                       │ in-process EventEmitter / Map<subId,res>
                  ┌────────────────────┼─────────────────────┐
            SSE   │              SSE   │               SSE    │
         /guest A │           /cassa   │            /regia    │
        (guest X) │        (guest X)   │         (event E)    │
```

- **One dedicated `pg.Client`** (NOT from the pool, NOT through pgbouncer — see §6) holds the three `LISTEN`s for the whole process. It is the only PG connection doing realtime. On `notification`, it parses `channel` + `payload` and pushes into an in-process registry of active SSE subscribers.
- **SSE endpoints** (Next.js Route Handlers, `runtime='nodejs'`, streaming `ReadableStream`):
  - `GET /api/stream/guest?guest=<id>` → subscribes to `guest_state` filtered to that `guest_id`, **and** `event_phase`. On match, writes an SSE event; the *client* then refetches authoritative state.
  - `GET /api/stream/regia` → subscribes to `event_phase` + `regia_stats` (staff only).
- **Why a registry, not a PG connection per client:** thousands of guests must not become thousands of PG connections. The single LISTENer multiplexes; SSE connections are cheap in-process objects.

### SSE response contract
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no        # disable proxy buffering (Railway edge / any nginx)

event: state
id: 1719400000123            # monotonic, used as Last-Event-ID on reconnect
data: {"guest_id":"…"}

:keep-alive                  # comment line every ~15s to defeat idle timeouts
```
A periodic `:keep-alive` comment every 15 s is mandatory — Railway's proxy and mobile networks drop idle connections, and the PWA must not see a silent-dead stream.

---

## 3. Burst handling — tap sessions must NOT notify per row

`register_taps(p_session, p_count)` is called repeatedly during a 30 s tap session by every guest, at up to `max_tap_al_secondo` (default 12) — potentially **hundreds of writes/second** to `public.taps` across the room. We must **not** emit a notify per tap and we must **not** trigger a refetch per tap.

Design decisions:
1. **No trigger on `public.taps`.** Tap progress is *not* live-pushed to guests at all. The guest's own tap UI is optimistic/local during the session; the authoritative `ticket_tap`/`livello_totem` lands on `guests` at session close (or as the RPC updates `guests`), and *that* `guests` UPDATE fires the normal `guest_state` notify once. So a guest sees one settle, not 360 flickers.
2. **Regia leaderboard is pull-with-coalesced-ping, not push.** `/regia` does not get a notify per tap. Instead:
   - Either a **debounced ping**: a statement-level trigger on `taps` that calls `pg_notify('regia_stats', …)` but guarded by a coalescing token so at most ~1 ping/sec reaches regia (implement with a lightweight per-event "dirty" flag table + a 1 Hz flush, or simplest: **don't trigger at all** and have `/regia` poll an aggregate RPC every 1–2 s during a tap session).
   - **Recommendation for MVP: polling.** `/regia` calls a `stats_snapshot(event_id)` read every 1.5 s while `fase` is in a tap-active state. Regia is a single privileged screen on a controlled device — a 1.5 s poll of one aggregate query is trivial load and removes all coalescing complexity. Reserve `regia_stats` NOTIFY for post-MVP if the poll proves too coarse.
3. **Coalescing at the SSE layer (general):** even for `guest_state`, the fan-out drops duplicate pings to the same subscriber within a short window (e.g. collapse to trailing edge every 250 ms). Because the client refetches authoritative state on each delivered ping, collapsing N pings into 1 refetch is strictly correct and saves DB reads under a topup storm.

Net: the burst-prone path (taps) generates **zero** realtime fan-out per tap; the leaderboard is a cheap periodic aggregate; only the rare, per-guest `guests` settle produces a (coalesced) ping.

---

## 4. SSE vs WebSocket — choose SSE

| Factor | SSE (chosen) | WebSocket |
|---|---|---|
| Direction needed | server→client only (client writes go through RPC API routes) | bidirectional (unused) |
| Transport | plain HTTP/1.1, works through Railway proxy with no upgrade dance | needs upgrade; some proxies fussy |
| Reconnect | **built-in** auto-reconnect + `Last-Event-ID` resend in the browser `EventSource` | hand-rolled |
| PWA fit | trivial, survives backgrounding reasonably with keep-alive | heavier |
| Auth | standard cookie/Authorization on the GET | trickier (no headers on browser WS handshake → token in querystring) |

We only ever push notifications downstream; all mutations already go through the (new) RPC API routes. SSE is the smaller, more robust choice and gives us `Last-Event-ID` reconnection for free. **Caveat:** browsers cap ~6 concurrent SSE connections **per origin over HTTP/1.1**. Mitigations: (a) one stream per tab is enough (guest screen = 1 stream); (b) serve over **HTTP/2** (Railway does) which removes the 6-connection cap. Keep it to **one EventSource per screen**, multiplexing guest_state + event_phase on that single connection.

---

## 5. RLS-awareness in the fan-out (security)

Postgres `LISTEN/NOTIFY` has **no row security** — anyone who can `LISTEN guest_state` sees every guest's pings. RLS protected this implicitly in Supabase Realtime (it replayed RLS on `postgres_changes`). We reconstruct that guarantee at **two** points:

1. **Subscription filter (fan-out):** `/api/stream/guest?guest=X` first verifies, from the request's own JWT, that the caller *is* guest X (or is staff). The endpoint then only forwards `guest_state` pings whose payload `guest_id === X`. A guest can never subscribe to another guest's id. This is the authorization gate; the channel being shared is irrelevant because the filter is per-subscription.
2. **Authoritative read still under RLS:** the client's follow-up refetch hits an API route that runs the `SELECT` as role `authenticated` with the caller's claims set via `set_config('request.jwt.claims', …)` — so even if a notify leaked, the actual data read is RLS-scoped to `auth.uid()` exactly as today (policy `guests_select`: self-or-staff). **The notify can only ever cause an unauthorized *refetch attempt*, which RLS then denies.** Defence in depth.

`event_phase` is public to all authenticated (RLS `events_select using(true)`), so no filter needed. `regia_stats`/regia stream is gated to `is_staff()` claims at the endpoint.

---

## 6. Connection topology on Railway (LISTEN vs pgbouncer)

The user's stack uses **pgbouncer**. Critical gotcha: **`LISTEN/NOTIFY` does not work through pgbouncer in transaction-pooling mode** (the listening session is multiplexed and loses its channel binding). Decision:

- The **LISTENer connects directly to the Postgres plugin** (private network DSN, bypassing pgbouncer), as a single long-lived connection. One per backend process/replica.
- **All RPC/read traffic continues through pgbouncer** as normal (the NOTIFY side works fine through any connection — only the LISTEN side needs the direct link).
- If the backend runs **multiple replicas**, each replica opens its own direct LISTENer (every replica receives every NOTIFY — that's fine, each only fans out to its own SSE clients). Budget: `replicas` extra direct connections on top of the pool. With 1–2 replicas this is negligible.
- Reconnect logic on the LISTENer: on `error`/`end`, reconnect with backoff and **re-issue all `LISTEN`s**; while disconnected, SSE clients keep their keep-alive but get no events — covered by §7's client refetch-on-reconnect, and additionally the LISTENer should emit a process-level "resubscribed" that triggers a broadcast refetch ping to all live SSE clients after a gap.

---

## 7. Resilience / reconnect (aligns with the review finding "re-fetch authoritative on reconnect")

- **Client `EventSource`** auto-reconnects and sends `Last-Event-ID`. On the `onopen`/first-message-after-reopen, the client **always performs one authoritative refetch** regardless of whether it missed events — this closes any gap during the disconnect window (matches the existing hook's "fetch initial state before listening" pattern, now also "fetch on every reconnect").
- The server may honour `Last-Event-ID` as a hint but, given the "notify = trigger only" model, it **does not need to replay missed events** — a single post-reconnect refetch supersedes any number of missed pings. So `Last-Event-ID` is used mainly to dedupe, not to replay. This keeps the server stateless (no per-client event buffer).
- **Visibility/backgrounding (PWA):** on `visibilitychange → visible`, force a refetch (mobile may have silently dropped the stream). The hook should also treat `EventSource.readyState === CLOSED` plus a stale timer as "refetch now".
- **Keep-alive** (§2) prevents false-dead streams; if no keep-alive for 2×interval, client tears down and lets `EventSource` reconnect.

---

## 8. Mapping to the code (what changes, what stays)

### Stays identical
- `docs/totem-night_db_schema.sql` — **add** the two trigger functions + triggers (additive migration). RPC bodies, RLS, grants, generated columns: untouched.
- `lib/rpc.ts` shape (`GuestRow`, `RpcError`) — reused; only the call mechanism underneath swaps from `supabase.rpc` to `fetch('/api/rpc/…')` (sibling lens).
- `tests/db.mjs` + contract/RLS tests — reused as-is. **Add** a small test that asserts `topup`/`consume` cause exactly one `guest_state` NOTIFY (LISTEN on a test connection, run RPC, assert one notification with the right `guest_id` and **no pin/saldi** in payload), and that a rolled-back RPC emits none.

### Changes — `lib/useGuestState.ts` (keep the exact public interface `UseGuestStateResult`)
Swap the Supabase channel for an `EventSource`, keeping `fetchRow` semantics:
```ts
// before: supabase.channel(...).on('postgres_changes', …).subscribe()
// after:
const es = new EventSource(`/api/stream/guest?guest=${guestId}`); // cookies carry JWT
es.addEventListener('state', () => { if (active) void fetchRow(); });   // ping → refetch
es.addEventListener('phase', () => { if (active) void fetchRow(); });   // optional
es.onopen = () => { if (active) void fetchRow(); };                     // reconnect refetch
es.onerror = () => { /* EventSource auto-reconnects; optionally surface 'reconnecting' */ };
// + visibilitychange → fetchRow();  + keep-alive watchdog
return () => { active = false; es.close(); };
```
`fetchRow` itself changes from `supabase.from('guests').select(...).single()` to `fetch('/api/guest/'+guestId)` returning the same projected columns (`GUEST_COLUMNS`). The hook's loading/error/projection logic is unchanged — **callers `/guest` and `/cassa` need no edit** (`useGuestState(guestId)` signature preserved).

### New files
- `lib/sse/listener.ts` — singleton LISTENer (direct DSN), registry `Map<subscriptionId, controller>`, dispatch on notification, reconnect+re-LISTEN with backoff.
- `app/api/stream/guest/route.ts` — SSE; authz (caller==guest or staff), filter `guest_state` by id, also forward `event_phase`, keep-alive.
- `app/api/stream/regia/route.ts` — SSE staff-only; `event_phase` + (post-MVP) `regia_stats`.
- `app/api/guest/[id]/route.ts` — authoritative read (RLS-scoped) backing `fetchRow`.

### `app/regia/page.tsx`
Resolve the existing `TODO(realtime)` markers: subscribe to `/api/stream/regia` for `event:phase` (live badge) and drive the stats blocks (presenze/gettoni/ticket) from the 1.5 s aggregate poll during tap-active phases (§3). No per-tap realtime.

### `lib/supabase/client.ts`, `server.ts`, `middleware.ts`
Removed once the sibling auth/transport lenses land (no `@supabase/ssr`). The realtime lens has no remaining dependency on them after `useGuestState` swaps to `EventSource`.

---

## 9. Open questions / sequencing
1. **Replica count of the Next backend on Railway** — decides how many direct LISTENers (and whether regia stats should be a NOTIFY broadcast vs per-replica poll). Default assumption: 1–2 replicas.
2. **Phase-change fan-out volume** is tiny (manual regia action) — safe to push inline.
3. **Order of migration:** land the triggers + LISTENer + `/api/stream/guest` + `/api/guest/[id]` **before** swapping `useGuestState`, so the new path can be smoke-tested against the existing DB while Supabase Realtime is still wired, then flip the hook in one commit. The "notify = trigger only" contract means the two transports are behaviourally interchangeable from the UI's perspective, so the cutover is low-risk and reversible.

**Bottom line:** the realtime swap is the *cheapest* part of the de-Supabase migration. Two additive triggers, one shared `pg_notify` channel per stream, a single direct-connection LISTENer fanning out over SSE, and a drop-in rewrite of one hook — everything else (schema, RPCs, RLS, contract tests, hook interface, screen code) is preserved. The "payload is a trigger, refetch is authoritative" invariant already baked into `useGuestState.ts` is what makes SSE + coalescing + lossy reconnect provably safe.