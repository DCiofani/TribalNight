# Changelog

Tutte le modifiche rilevanti a **Totem Night**. Formato: [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioning [SemVer](https://semver.org/lang/it/).

> Questo file è mantenuto aggiornato a ogni modifica rilevante (regola di progetto).

## [Unreleased]

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
- _(prossimo: Fase 4 realtime SSE (LISTEN/NOTIFY → EventSource, sostituisce il polling); Fase 5 deploy — wiring `DATABASE_URL`/`AUTH_DB_URL` su Railway al Postgres dello stack, flip `NEXT_PUBLIC_BACKEND=api`, spegni Kong/GoTrue/PostgREST/Realtime)_

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
