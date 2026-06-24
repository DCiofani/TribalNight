# Totem Night — app

PWA mobile-first (Next.js App Router) + Supabase (Postgres + Realtime + RLS) per un aperitivo cenato tribale: totem digitale, credito prepagato Normale/Premium, sessioni di tap a tempo, estrazione finale pesata sui ticket.

> **Fonte di verità:** [`docs/totem-night-spec-pack.md`](docs/totem-night-spec-pack.md) (prodotto) e [`docs/totem-night_db_schema.sql`](docs/totem-night_db_schema.sql) (**contratto tecnico autoritativo v0.2**: 14 RPC `SECURITY DEFINER` + RLS). Il front-end **non ricalcola mai** saldi/ticket: chiama le RPC e ascolta il Realtime.
> **Piano:** [`PLAN.md`](PLAN.md). **Decisioni OQ + delta v0.2:** [`docs/design/v0.2-reconciliation.md`](docs/design/v0.2-reconciliation.md).

## Struttura

```
app/            route PWA: / · /onboarding · /guest · /cassa · /regia
components/     componenti client (es. ServiceWorkerRegister)
lib/            config (nome app), supabase client/server, current_event(), totem-levels
public/         manifest.webmanifest, sw.js, icon.svg (placeholder)
supabase/
  migrations/   0001_init.sql  (= schema v0.2, applicare come migrazione singola)
  ci/           prelude.sql (shim ruoli+auth) · assert.sql (contract check)
  seed.sql      seed dev/staging (evento APERTA + listino)
docs/           spec-pack, schema, flussi, branding, T&C + docs/design/ (design doc agenti)
.github/        CI (lint · typecheck · build · migrazione + assert)
.claude/agents/ team hull (10 sub-agent) — attivi dopo riavvio di Claude Code
```

## Setup Supabase (T-M1-01 — azioni manuali)

1. Crea un progetto Supabase (dev + staging).
2. **Auth → Anonymous sign-in: ON** (ogni telefono = un ospite).
3. **Ruoli staff:** imposta il claim `app_metadata.role ∈ {cassa, regia, admin}` sugli account staff **via Admin API / service_role** (⚠️ MAI in `user_metadata`: sarebbe modificabile dall'utente — vedi rischio R-10).
4. Applica lo schema come **migrazione singola**:
   ```bash
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0001_init.sql
   ```
5. (dev/staging) seed: `psql "$SUPABASE_DB_URL" -f supabase/seed.sql`.
6. Copia `.env.example` → `.env.local` e compila URL + anon key.

> Deploy a **evento singolo**: il client non passa `event_id`, lo risolve da `current_event()` (`lib/events.ts`).

## Sviluppo

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck
npm run build
```

## CI

`.github/workflows/ci.yml`: lint + typecheck + build PWA; in parallelo applica la migrazione v0.2 su un Postgres effimero (via `prelude.sql`) e verifica il contratto (`assert.sql`). I contract/RLS test runtime arrivano in **M1-S2**.

## Team hull

10 sub-agent in `.claude/agents/`. Dopo `git`/restart, verifica con `/agents`; lavora a milestone seguendo [`PLAN.md`](PLAN.md).
