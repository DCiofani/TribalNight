# Changelog

Tutte le modifiche rilevanti a **Totem Night**. Formato: [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioning [SemVer](https://semver.org/lang/it/).

> Questo file è mantenuto aggiornato a ogni modifica rilevante (regola di progetto).

## [Unreleased]

_(prossimo: M1-S2 — hardening RPC `register_guest`/`topup` + suite contract/RLS test runtime)_

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
