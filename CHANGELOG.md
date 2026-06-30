# Changelog

Tutte le modifiche rilevanti a **Totem Night**. Formato: [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioning [SemVer](https://semver.org/lang/it/).

> Questo file è mantenuto aggiornato a ogni modifica rilevante (regola di progetto).

## [Unreleased]

### M2/M3 — cablaggio cassa-consumo + regia al backend api ✅
- **Workflow multi-agente (analisi → build → review → verifica reale).** Fase analisi (4 reader ∥ + sintesi) → piano ordinato per rischio; fase build (7 agent file-disgiunti ∥) + review avversariale (param-parity + security).
- **3 GAP read-side creati** (nessuno muta stato evento): (1) **lista drink** leggibile dal client — handler `GET /api/regia/drink?event=<id>` (aggiunto alla route esistente, requireRole cassa/regia/admin, SELECT `public.drinks` attivi ordinati; RLS `drinks_select` già autorizza, zero policy nuove) + wrapper `listDrinks` + `type DrinkRow` in `lib/rpc.ts`; (2) **stats regia aggregate** — nuova migrazione `0005_stats.sql` con RPC `public.event_stats(p_event)` (SECURITY DEFINER, gate `is_staff()`, grant authenticated) che ritorna `{fase, presenze, gettoni_venduti, ticket_totali}` calcolati **server-side** (il client non somma nulla) + route `GET /api/regia/stats` + wrapper `getEventStats`/`type EventStats`; `assert.sql` aggiornato con la firma; (3) **stream fase regia** — route SSE `GET /api/stream/regia?event=<id>` che riusa `subscribePhase` (listener già esistente, prima senza consumatori), **filtrata per event_id** (canale globale).
- **CASSA — consumo al bar (§7.3) cablato** (`app/cassa/page.tsx`): drink-picker (da `listDrinks`) + `handleConsume` via wrapper `consume` già pronto, con `consumeIdemRef` idempotente (azzerato su successo/cambio drink/cambio ospite). Nessun saldo ricalcolato lato client → `useGuestState` si riallinea via SSE. Flusso esistente (login/lookup/topup) invariato.
- **REGIA — pannello cablato** (`app/regia/page.tsx`, prima 100% mock): gate ruolo `regia`/`admin` (cassa rifiutata); fetch iniziale `getEventStats` → fase + 3 stat dal server; live via `EventSource('/api/stream/regia')` (refetch stats sul segnale) con **fallback polling ~3s**; controlli `setPhase` (SETUP→…→CHIUSA), `startSession(30)`, `runDraw(3)` (auto-transizione a ESTRAZIONE prima del sorteggio) con busy/error. Firme pubbliche stabili, branch `USE_API`, path supabase invariato.
- **Review applicata:** [high] `event_stats` ritornava `bigint` → node-postgres serializza int8 come **stringa**, rompendo il contratto `EventStats {number}` e la parità col path supabase → cambiato a `int` (conteggi serata stanno in int4). [low] evento inesistente → la route stats ora risponde **404** (parità con `getEventStats` che lancia sul path supabase).
- ✅ **Verifica reale (testing effettivo, Postgres effimero `postgres:15`, mai prod):** `tsc --noEmit` pulito sul tree combinato; migrazioni `prelude→0000…0005` clean + **`assert.sql` verde** (firma `event_stats`); **81 contract test verdi** (`node --test`, 0 fail) = 55 esistenti (register_guest/topup/rls) + **26 nuovi**: `consume` (happy normale/premium, idempotenza, saldo insufficiente, drink invalido/non-attivo, gating fase, RBAC ospite), `event_stats` (coerenza coi grezzi, gettoni solo ricariche, fase segue set_phase, RBAC ospite/cassa), `regia` (ciclo set_phase, start_session solo-APERTA/una-alla-volta, e2e tap→close idempotente, run_draw seed-deterministico + gating fase + n_winners<1 + RBAC). `next build` (`NEXT_PUBLIC_BACKEND=api`) verde: route `/api/regia/stats`, `/api/regia/drink`, `/api/stream/regia` compilate, pagine `/cassa`+`/regia` renderizzano.
- Note: pagine restano **placeholder sostituibili dal design** (logica isolata nei wrapper). Drink-picker usa `nome·tipo` (descrizione/categoria/immagine_url disponibili in `DrinkRow` per il design). Stats live oggi via stream-fase + refetch (o polling fallback); trigger `pg_notify` dedicato sugli aggregati = hardening opzionale post-M3. `subscribePhase` richiede `DATABASE_URL_DIRECT` (no pgbouncer) per ricevere le NOTIFY.

### Migrazione — Fase 5 chiusa: soak prod + cleanup wrapper ✅
- **Soak prod reale (e2e live 14/14):** `tests/prodtest` contro `web-production-2df81.up.railway.app` sul backend nuovo — anon → current_event → register → ospite-legge-sé (RLS) → staff login (role cassa) → lookup PIN → topup +3 → ospite vede saldo 3 → negativo ospite-non-topup (403) → **SSE realtime** (evento dopo topup) → **consume** path OK (drink invalido → 400) → **RBAC** ospite/cassa non estraggono (403) → **phase-guard** convert in APERTA → 400. Tutto verde sul Postgres+Next+auth propria, **senza** alcun wrapper Supabase.
- **Cleanup wrapper eseguito (11→2 servizi):** rimossi da Railway i 9 servizi del template Supabase (Kong, Gotrue Auth, Postgrest, Supabase Realtime, Supabase Studio, Postgres Meta, Supabase Storage, S3, Imgproxy). Restano **`web`** (Next) + **`Postgres`** (dati: guest, `app_auth`, evento). Pre-check: var `web` sono **letterali** (non reference) → `DATABASE_URL`→`postgres.railway.internal`, `NEXT_PUBLIC_SUPABASE_URL` stringa fissa → la rimozione di Kong non svuota nulla né rompe rebuild futuri.
- ✅ **Ri-verificato dopo la rimozione:** stesso e2e **14/14 PASS** → backend nuovo totalmente indipendente dai wrapper. Rollback net ritirato (atteso: la modalità `supabase` non è più servita; il backend `api` è l'unico). MIGRAZIONE COMPLETA.
- ⚠️ **Residui go-live:** (a) il soak ha creato guest usa-e-getta sull'evento live → ripulire/riseminare l'evento prima della serata vera; (b) ruotare i secret prod (`JWT_SECRET`, staff pw) come da [[rotate-shared-credentials]].

### Migrazione Supabase → Postgres/Next — Fase 0+1 (auth propria) ✅
- **Fase 0 (fondamenta DB):** `supabase/migrations/0000_prelude.sql` — promosso da shim CI a migrazione prod (ruoli anon/authenticated/service_role/**authenticator** + schema `auth.uid/role/jwt`); lo schema `0001` resta invariato. `lib/db.ts` `withAuth(claims, fn)` (= `tests/db.mjs::actAs` con commit; `set local role authenticated` + `set_config(request.jwt.claims)` → pgbouncer-safe).
- **Fase 1 (auth propria, sostituisce GoTrue):** `0003_auth.sql` (`auth.staff_users` + `auth.refresh_tokens`); `lib/auth-server/*` — JWT HS256 (`jose`, audience+clockTolerance), password **argon2id**, refresh **opaco hashato con rotazione + reuse-detection kill-all**, `service-db` dedicato (fail-fast, mai authenticator), guard `requireRole`; endpoint `/api/auth/{anon,login,refresh,logout,me}` (cookie HttpOnly+Secure+SameSite=Strict, CSRF Sec-Fetch-Site/Origin).
- Generato via Workflow multi-agente; **review applicata** (2 critical schema↔codice + high security: dummy-hash argon2 runtime, refresh-reuse kill-all, IP rate-limit, least-privilege authenticator, SameSite Strict). Fix in extra: `replaced_by` uuid (insert `returning id`).
- ✅ **Verificato reale:** migrazioni `0000→0003` clean su Postgres puro + **30/30 contract test verdi** (nucleo migra 1:1); auth runtime su PG locale: anon/login/me/refresh-rotation/401-pw-errata/**reuse→kill-all** tutti ok. build/lint/typecheck verdi.
- Strangler: codice NUOVO accanto a Supabase (ancora live, non wired al client). Deps: +`jose`+`argon2`+`server-only`, `pg`→dependencies.
- **Fase 2 (14 RPC + 2 read-through come Next API routes)** ✅: `app/api/**` — event/current, guest/register, guest/[id], cassa/{guest,topup,consume}, credit/convert, tap, regia/{phase,session/start,session/close,draw,settings,drink,drink/visibility,drink/active}. Pattern uniforme: `sameOriginOk` + `requireRole`/`requireAuth` (difesa-in-profondità) → `withAuth(claims)` → RPC; errori RPC `P0001`→400 col testo utente, altri SQLSTATE→400 generico (no leak), non-pg→500. `lib/db.ts` reso **lazy** (pool alla 1ª query, non a import-time → `next build`/CI senza creds DB). Review applicata: validazione `p_idem` uuid (topup/consume/convert), clamp `count` int4 (tap), no messaggi pg grezzi.
- ✅ **Verificato:** build con solo env CI (niente DATABASE_URL/AUTH_DB_URL/JWT_SECRET) verde; `tests/api_http.test.mjs` (integrazione HTTP reale: anon→event→register→read-self, cassa login→topup→ospite-vede-saldo, negativo ospite-non-topup) **verde** su Postgres+auth reali; typecheck pulito.
- **Fase 3 (cutover client feature-flagged)** ✅: `lib/backend-mode.ts` (`USE_API` da `NEXT_PUBLIC_BACKEND`, **default `supabase`** → push su main NON rompe la prod) + `lib/api.ts` (fetch tipizzati, `credentials:'include'`, errori→`RpcError`). `lib/rpc.ts`/`events.ts`/`auth.ts`/`useGuestState.ts` + `app/onboarding` branchano su `USE_API`: API path → `/api/*` (anon, register, current_event, topup, lookup, login/me/logout, guest read via **polling 2s** TODO(SSE Fase 4)); path supabase invariato. Firme pubbliche immutate (pagine non toccate); moduli client senza import server-only.
- ✅ **Verificato:** typecheck + build (`NEXT_PUBLIC_BACKEND=api`, env CI) verdi; flusso `/api` dal browser su Postgres locale (anon 200 → current_event 200 → register 200, guest creato + `auth_uid` legato) — il contratto fetch dei wrapper gira contro il backend nuovo. `lib/db.ts` reso lazy (build senza creds).
- **Fase 4 (realtime SSE)** ✅: `0004_notify.sql` (trigger `AFTER UPDATE guests` → `pg_notify('guest_state',{guest_id})` e `AFTER UPDATE OF fase events` → `event_phase`; payload **solo id**, mai pin/saldi; **nessun trigger su taps** anti-burst). `lib/sse/listener.ts` (connessione PG **diretta** dedicata — LISTEN non funziona con pgbouncer — registry + fan-out + reconnect/backoff). `app/api/stream/guest/route.ts` (SSE, authz RLS via withAuth, keep-alive, unsubscribe su abort). `lib/useGuestState.ts` path API: **EventSource** al posto del polling → refetch autoritativo su evento/onopen/visibilitychange, fallback polling. Path supabase invariato.
- ✅ **Verificato:** SSE e2e reale su Postgres locale — topup → UPDATE guests → `pg_notify` → listener → `event: state` ricevuto dal client; build/typecheck verdi.
- **Fase 5 prep — rianalisi cutover (workflow multi-agente)**: sondato il Postgres prod reale → **blocker trovato**: GoTrue ha già `auth.refresh_tokens`/`auth.users` → collisione col mio `0003`. **Fix:** tabelle auth proprie spostate in schema dedicato **`app_auth`** (`app_auth.staff_users`/`refresh_tokens`); `auth.uid/role/jwt` restano in `auth`. Aggiornati `0003_auth.sql` + `lib/auth-server/{refresh,staff}.ts`. Ri-testato: `0000→0004` clean su Postgres vanilla, `api_http` 2/2, auth login/refresh/me 200 (refresh ora su `app_auth.refresh_tokens`). Runbook cutover prodotto.
- **Fase 5 (cutover prod) ✅ LIVE**: applicati al Postgres dello stack `0003`(app_auth)+`0004`(notify)+grant (NON `0000`: `auth.uid` di Supabase lasciata intatta per non rompere l'app live durante la transizione). Staff `cassa@totem.local` seedato in `app_auth`. Var su `web` (via CLI `railway variables`): `DATABASE_URL`/`DATABASE_URL_DIRECT`=`authenticator@postgres.railway.internal`, `AUTH_DB_URL`=`postgres@internal`, `JWT_SECRET` nuovo, `NEXT_PUBLIC_BACKEND=api` → rebuild. **Verificato live** su `web-production-2df81.up.railway.app`: `/api/auth/anon`→`current_event`→`register` 200, guest creato nel Postgres dello stack (auth_uid legato). Prod ora su **Postgres + Next API + auth propria**.
- **Rollback net attivo:** Kong/GoTrue/PostgREST/Realtime **lasciati vivi** finché non si fa soak (runbook: spegnere per ultimi). Rollback = `railway variables --set NEXT_PUBLIC_BACKEND=supabase` → rebuild. Cleanup finale (rimuovere i 4 wrapper → 7→2 servizi) **dopo soak**; richiede write Railway (CLI `service delete`/dashboard; OAuth flaky).
- 🔐 Nuovi secret prod (JWT_SECRET, staff pw `cassa@totem.local`) in var Railway / da comunicare; ruotare al go-live.

### Fase 3 — completamento write-surface client (cassa/regia) ✅
- **Buco strangler chiuso:** la Fase 3 aveva branchato solo `topup`/`lookup`/`register`/auth/`current_event`/guest-read; le altre scritture (`consume`, `tap`, `convert`, e tutto il dominio regia) non avevano wrapper flag-branched, quindi al cablaggio M2/M3 rischiavano di chiamare `supabase-js` diretto e bucare il cutover. **Con Fase 5 LIVE (`NEXT_PUBLIC_BACKEND=api` in prod) questi wrapper sono load-bearing**: vanno usati da subito quando M2/M3 cablerà cassa-consumo/regia. Aggiunti **a monte del cablaggio** (oggi le pagine restano placeholder: regia mock, `consume`/regia non ancora collegati → nessuna rottura live attuale).
- `lib/rpc.ts` += `consume` (`/api/cassa/consume` ↔ rpc `consume`), `registerTaps` (`/api/tap` ↔ `register_taps`, count cumulativo), `convertCredit` (`/api/credit/convert` ↔ `convert_credit`). Nuovo **`lib/regia.ts`** (UNICO write-surface regia) = `setPhase`, `runDraw`, `updateEventSettings` (9 campi opzionali), `startSession`, `closeSession`, `upsertDrink`, `deleteDrink`, `setDrinkVisibility`, `setDrinkActive`.
- Stesso pattern di `topup`: `if (USE_API) apiPost/apiPatch/apiDelete else supabase.rpc`; **path supabase INVARIATO**, firme pubbliche stabili, nessun import `server-only`. `deleteDrink` usa `apiDelete(path, body?)` — la forma con body **era già presente** in `lib/api.ts` (HEAD): **nessuna modifica ad `api.ts`** in questo changeset. Normalizzata la divergenza di shape di `close_session` (int "nudo" supabase vs `{ ticket }` route) → `number` (`res?.ticket ?? 0`). **`useGuestState` realtime già a posto da Fase 4 — nessuna modifica.**
- ✅ **Verificato (workflow multi-agente: 3 implementer ∥ → verify + review avversariale param-parity + test-strategist):** `tsc --noEmit` pulito (2× con full re-check) e `next build` (`NEXT_PUBLIC_BACKEND=api`, env CI) verde, tutte le 23 route `/api` compilate. **Param-parity review verde** sui 12 wrapper (+ `apiDelete` già esistente) vs route + firme RPC `0001_init.sql` — 0 critical/high/medium, 1 low applicato (guard `res?.ticket ?? 0` su `closeSession`). Le route target (`consume`/`tap`/`credit-convert`/regia/*) **non hanno copertura HTTP**: TODO estendere `tests/api_http.test.mjs` in CI/locale (serve PG + server + staff seedato). `npm run lint` locale rosso per `node_modules` corrotto (`tsconfig-paths/lib/tsconfig-loader.js` mancante — `rm -rf node_modules && npm ci` lo risolve), **non** per il codice; CI pulita.

### Added
- **Schermate temporanee swappabili** (in attesa del design definitivo da Claude Design), generate e revisionate via Workflow multi-agente:
  - Layer primitivi UI token-driven: `components/ui/{Screen,Card,Button,Stat,index}` + barrel.
  - Componente `components/Totem.tsx` **isolato e sostituibile** (prop `level` 0–6, anelli/glow/scintille demo).
  - Route funzionali-placeholder: `/onboarding` (form nome + T&C), `/guest` (Totem + saldi + ticket + QR/PIN + menù), `/cassa` (azioni ricarica/consuma), `/regia` (fasi + stats + controlli) — tutti con dati mock statici marcati `TODO(RPC)`/`TODO(realtime)`, nessun ricalcolo client.
  - Route `/terms` (T&C provvisori) per chiudere il gate legale dell'onboarding.
- A11y: classi `.btn` (hover/active/`:focus-visible`) + `@media (prefers-reduced-motion: reduce)` in `globals.css`.

### Note
- Review multi-agente (code-reviewer + spec-guardian): `tsc`/`lint` puliti; fix applicati (link T&C → `/terms`, oro riservato ai momenti-premio, focus-visible via CSS).
- Verificato in locale nel browser (build verde, render OK guest/onboarding, zero errori console).

### Testing (M1-S2)
- **Suite di test REALE** (no mock) per `register_guest` + `topup` + RLS, generata via Workflow multi-agente (test-strategist → test-author): `tests/db.mjs` (harness `pg` + simulazione auth `set local role authenticated` + `request.jwt.claims`, `actAs`/`expectReject` con savepoint) + `tests/{register_guest,topup,rls}.test.mjs`. Casi: contract, idempotenza, gating fase, authz, validazione, RLS per ruolo, default-deny scritture dirette. Documenta il finding **R-01** (idem riusato con parametri diversi → ritorna la tx originale).
- Dipendenza `pg` + script `npm test` (`node --test`); CI estesa: il job migrazione ora applica schema + assert + **esegue i test** su Postgres effimero.
- ✅ **29/29 test verdi** su Postgres 15 reale (Docker locale): register_guest 6, topup 11, RLS 12, 0 fail.

### Added (M1-S3 — wiring reale)
- Data-layer client (via Workflow multi-agente: analyst → implementer → e2e → review):
  - `lib/rpc.ts`: wrapper tipizzati `registerGuest`/`topup` (idem key client) + `RpcError`.
  - `lib/useGuestState.ts`: hook realtime su `guests` (saldi/ticket/livello/pin) — fetch iniziale + re-fetch su evento postgres_changes (le colonne GENERATED non sono nel payload) + teardown.
  - `lib/guest-session.ts`: persistenza `guestId` (localStorage, SSR-safe).
- `/onboarding` cablato: anonymous sign-in → `register_guest` (`current_event`) → salva guestId → `/guest`. `/guest` mostra dati LIVE (no mock, no ricalcolo client).
- `supabase/config.toml` (stack locale `supabase start`, anonymous sign-in abilitato).
- **Cassa cablata** (Workflow multi-agente): `lib/auth.ts` (login staff `signInWithPassword` + `getSessionRole` + `isStaffRole`), `lib/rpc.ts` `lookupGuestByPin` (SELECT diretta, RLS staff), `app/cassa/page.tsx` flusso completo: gate ruolo → login staff → lookup ospite per PIN → Totem+saldi live → ricarica via `topup` con **idem stabile** (`idemRef`, retry-safe anti doppio-addebito) → re-fetch realtime. Consuma resta TODO(M2).

### Testing (M1-S3)
- **E2E REALE** `tests/e2e_supabase.test.mjs` (supabase-js contro Supabase locale): admin crea utente staff `cassa` → ospite anon sign-in → `register_guest` → `topup` (cassa) → ospite rilegge saldo via RLS → **idempotenza** (stesso idem non raddoppia). Skip pulito se env assente.
- ✅ **30/30 test verdi** su Supabase locale reale (29 contract/RLS DB + 1 e2e full-path). Build/lint/typecheck verdi.
- ✅ **Verifica browser**: onboarding → /guest live (guest creato nel DB, saldi/ticket/totem reali via `useGuestState`), zero errori console.
- **E2E cassa** `tests/cassa_e2e.test.mjs`: login staff → lookup per PIN (RLS staff) → `topup` premium → rilettura saldo + caso negativo (ospite non-staff NON vede il PIN altrui). ✅ verde su stack locale.
- Nota CI: gli e2e Supabase fanno skip in CI (nessuno stack nel runner); i 29 contract/RLS girano su Postgres effimero. Gli e2e sono gate locale (`supabase start`) / verificati anche contro Railway.

### Deploy / Infra (tutto su Railway — niente vendor esterno)
- **App `web`** (progetto Railway TotemNight / Uledia): repo `DCiofani/TribalNight` branch `main`, **auto-deploy on push**, Nixpacks; dominio `https://web-production-2df81.up.railway.app`.
- **Supabase self-hosted su Railway** (template `supabase`): servizi Kong, Gotrue Auth, PostgREST, Realtime, Postgres (volume), Storage, Studio, Postgres-Meta. Bootstrap secret completato (JWT secret unico + anon/service key generati e propagati a tutti i servizi; `GOTRUE_SITE_URL` + anonymous sign-in ON). API pubblica: `https://kong-production-1e5e.up.railway.app`.
- Migrazione **v0.2 applicata** al Postgres self-hosted + evento `Totem Night` (APERTA) + 3 drink seed.
- `web` puntato al Kong (`NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` inlinati a build-time, verificato nel bundle).
- ✅ **E2E reale VERDE contro Railway** (anon sign-in → register_guest → topup staff → RLS → idempotenza). Account staff `cassa@totem.local` (role `cassa`) creato.
- 🔐 Secret (JWT secret, service key, DB password, staff pw) vivono nelle **variabili Railway** = fonte di verità; **da ruotare** prima del go-live pubblico.

### Infra review (multi-agente) + hardening
- Report `docs/design/railway-infra-review.md` (5 lenti + sintesi). Verdetto: **funziona ma non ottimale as-is** (11 servizi per 6 usati, mai load-testato). Rischi serata: auto-deploy attivo, no backup, tap-burst non testato. Self-host ok per 1° evento.
- **Fix GDPR applicato**: `supabase/migrations/0002_draws_select_staff.sql` — `draws_select` da `using(true)` a `using(is_staff())` (gli anon non scaricano più nomi+ticket della platea dopo l'estrazione). Applicato al Postgres Railway + CI ora applica tutte le migrazioni in ordine.
- ⏳ Da fare (review): taglio 5 servizi morti (Storage/S3/Imgproxy/Studio/PG-Meta) + verifica regione EU — **bloccati da Railway OAuth flaky** (MCP/CLI Unauthorized); da dashboard o al ripristino auth. Pre-evento: freeze auto-deploy, pg_dump loop, load-test tap in staging, throttle tap cumulativo (M3).

_(prossimo: M2 `consume`; pre-evento: quick wins infra rimanenti)_

## [0.1.0] — 2026-06-24 — M1-S1 Fondamenta

### Added
- Team multi-agente **hull** (10 sub-agent) in `.claude/agents/`.
- `PLAN.md` end-to-end: 65 task su M1–M5 (3 sprint each), grafo dipendenze, matrice agente↔task, registro rischi, Open Questions, proposta M1-S1.
- 7 design doc in `docs/design/` (backend, frontend, integrazioni, test-strategy, review-checklist, spec-guardian-report) + `v0.2-reconciliation.md`.
- Scaffold **Next.js 14 App Router PWA mobile-first**: route `/onboarding` `/guest` `/cassa` `/regia` + landing.
- PWA: `app/manifest.ts` (config-driven), service worker (`public/sw.js`), icone (`icon.svg` + PNG 192/512 + `apple-icon.png`).
- Design system: token branding in `:root` (`app/globals.css`), nome app in `lib/config.ts`, mapping totem livelli 0–6 (`lib/totem-levels.ts`).
- Integrazione Supabase: client browser/server (`@supabase/ssr`), helper `current_event()` (`lib/events.ts`), `middleware.ts` per refresh sessione.
- Database: `supabase/migrations/0001_init.sql` (schema v0.2 come migrazione singola) + `supabase/seed.sql` (dev).
- CI GitHub Actions (`.github/workflows/ci.yml`): lint · typecheck · build PWA + applicazione migrazione su Postgres effimero con `supabase/ci/prelude.sql` + verifica contratto `supabase/ci/assert.sql` (14 RPC + grants + RLS default-deny).
- `README.md` (setup + provisioning Supabase) e questo `CHANGELOG.md`.

### Changed
- **Schema → v0.2** (contratto tecnico autoritativo):
  - `register_taps(session, count)`: conteggio **cumulativo** monotòno + idempotente, validazione tempo lato server (rimosso `p_elapsed_ms`).
  - nuovo helper `current_event()` (deploy a evento singolo: il client non passa `event_id`).
  - **PIN univoco per evento** (`unique(event_id, pin)` + retry in `register_guest`); identificatore primario alla cassa = QR su `guest.id`.
- `next` 14.2.15 → **14.2.35**.

### Fixed
- `middleware.ts`: **no-op se Supabase non configurato** (`NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` assenti) → l'app gira anche prima del provisioning.
- A11y: riabilitato pinch-to-zoom (rimossi `maximumScale`/`userScalable`, WCAG 1.4.4).
- `supabase/ci/assert.sql` esteso: verifica tutte le 14 RPC + grant execute + default-deny (nessuna policy di scrittura).

### Security
- `next` aggiornato per CVE advisory 2025-12-11.
- Ruolo staff impostato **solo** in `app_metadata.role` via Admin API/service_role (mai `user_metadata`) — documentato (rischio R-10).
- Nessun secret nel repo (`.env*` e `node_modules` in `.gitignore`; solo `.env.example`).

### Decisioni (Open Questions risolte)
- Ricarica **POS/contanti** via `topup()`, **niente Stripe in v1** (OQ7).
- Identità: **QR su `guest.id`**, PIN fallback unico per evento (OQ8).
- **Un evento attivo per deploy** via `current_event()` (OQ9).
- Default **3 vincitori** configurabili (OQ4/OQ6); validazione legale DPR 430/2001 + GDPR = gate di rilascio.
- 1 utente = 1 device: v1 anonymous + mitigazioni soft; login OTP = hardening successivo (OQ10).

### Note
- Migrazione **non re-runnable as-is** (`create policy` senza guardia): modello apply-once; dettaglio in `docs/design/v0.2-reconciliation.md §4`.
- Verifiche locali: build/lint/typecheck verdi; migrazione v0.2 clean-apply + assert su Postgres 15; run locale verificato nel browser.

[Unreleased]: https://github.com/DCiofani/TribalNight/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DCiofani/TribalNight/releases/tag/v0.1.0
