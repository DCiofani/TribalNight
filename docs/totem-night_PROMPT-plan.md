# Prompt-piano per Claude Code (Totem Night)

> Incolla tutto il blocco sotto in Claude Code, dopo aver messo lo zip in `docs/`.
> Obiettivo: far generare un **piano completo multi-agente** (con `hull`) PRIMA del codice.

---

# OBIETTIVO
Crea un **PIANO COMPLETO di implementazione** per la piattaforma "Totem Night" (web app per aperitivo cenato a tema tribale: totem digitale, credito prepagato a consumazioni Normale/Premium, sessioni di "tap" a tempo, estrazione finale pesata sui ticket, dashboard regia con gestione menù/prezzi). In QUESTA fase **non scrivere codice di feature**: usa il team multi-agente per produrre il piano end-to-end dell'intera piattaforma.

# MATERIALE (in `docs/`)
- `totem-night-spec-pack.md` — Spec Pack (fonte di verità di prodotto).
- `totem-night_db_schema.sql` — schema Postgres: 14 RPC `SECURITY DEFINER` + RLS = **contratto tecnico autoritativo** del backend.
- `totem-night_flussi.md` — diagrammi flussi + macchina a fasi (SETUP→APERTA→LAST_CALL→ESTRAZIONE→CHIUSA).
- `totem-night_termini-e-condizioni_BOZZA.md` — testo onboarding.
- `totem-night_branding.md` — branding placeholder (colori/nome cambieranno).

# VINCOLI NON NEGOZIABILI
1. Lo schema SQL è la fonte di verità: il front-end **non ricalcola mai** saldi/ticket. Tutte le scritture passano dalle RPC (`register_guest`, `topup`, `consume`, `start_session`, `register_taps`, `close_session`, `convert_credit`, `run_draw`, `update_event_settings`, `upsert_drink`, `set_drink_visibility`, `set_drink_active`, `delete_drink`). Stato live via Supabase Realtime.
2. Stack: Next.js (App Router) PWA mobile-first + Supabase (Postgres + Realtime + RLS). Route: `/onboarding`, `/guest`, `/cassa`, `/regia`.
3. Supabase: Anonymous sign-in; staff con claim `app_metadata.role` ∈ cassa/regia/admin; schema applicato come migrazione.
4. Totem: componente **isolato e sostituibile**; per la demo un **MODELLO DI TOTEM AFRICANO** placeholder; livelli 0–6 mappati su `guests.livello_totem`.
5. Branding placeholder: colori in token (`:root`), nome app in config.
6. Operazioni **gated per fase**; anti-cheat tap **server-authoritative**.

# PASSO 1 — Installa il team multi-agente (hull)
Usa la skill `hull` per installare i 10 sub-agent in `.claude/agents/` (leggono `*spec-pack*.md` come fonte di verità). Dimmi di riavviare Claude Code e verifica con `/agents`. Ricorda il limite: un subagent non può spawnarne un altro → `@orchestrator` produce un **piano di delega** che la sessione principale esegue turno per turno.

# PASSO 2 — Produci il PIANO COMPLETO (`PLAN.md`), non il codice
Coordina gli agenti per un piano dell'INTERA piattaforma:
- `@orchestrator` → piano di delega complessivo + sequenziamento dei workflow.
- `@plan-architect` → `PLAN.md`: fasi → sprint → task, con dipendenze, parallelizzazione e Definition of Done per milestone.
- `@spec-guardian` → verifica che ogni task citi lo Spec Pack / le RPC; segnala gap e **Open Questions (OQ)**.
- `@backend-analyst` ∥ `@frontend-analyst` → design doc di alto livello per ogni milestone (contratti = le RPC; mappa schermate/stato/routing) PRIMA del codice.
- `@integration-specialist` → piano integrazioni (Supabase auth/anonymous, Realtime, eventuale Stripe/POS, storage asset totem, push/notifiche).
- `@test-strategist` → strategia test e gate CI (contract test RPC, RLS per ruolo, idempotenza, anti-cheat, estrazione riproducibile).
- `@code-reviewer` → checklist review trasversale (idempotenza, race condition, sicurezza RLS, rate limit tap).

# WORKFLOW MULTIPLI da prevedere nel piano
Applica a ogni task il workflow giusto e indica cosa va in **parallelo** e cosa è **bloccante**:
- **Feature** (maggioranza): orchestrator → plan-architect → spec-guardian → (backend-analyst ∥ frontend-analyst) → *contratto API* → (backend-implementer ∥ frontend-implementer) → test-strategist → code-reviewer.
- **Integrazione esterna** (auth, realtime, pagamenti, storage, push): integration-specialist owner → spec-guardian (consensi/audit) → code-reviewer (idempotenza, verifica firme, rate limit).
- **Decisione architetturale**: spec-guardian cerca decisioni esistenti → analyst propone → plan-architect aggiorna `PLAN.md`.

# WORKSTREAM TRASVERSALI (in parallelo alle milestone)
- **Infra/DevOps**: repo scaffold, CI, progetto Supabase, migrazioni, env/secrets.
- **Design system & tema**: token colore/tipografia, **componente Totem (africano demo, sostituibile)**, livelli 0–6, firme di motion (ignite / tap-burst / count-up / reveal).
- **Realtime**: canali `event:phase`, `session:state`, `session:leaderboard`, `guest:state`, `admin:stats`.
- **Integrità & anti-cheat**: validazione tap server-side, idempotenza pagamenti, riconciliazione cassa.
- **QA & sicurezza**: contract test RPC, test RLS per ruolo, estrazione provably-fair, e2e su device.
- **Predisposizioni compliance** (tecniche, non validazione legale): log accettazione T&C (`consenso_tos_at`), salvataggio seed+snapshot estrazione.

# MILESTONE da coprire (decomponi ciascuna in sprint + task)
- **M1 Fondamenta** — schema applicato, anonymous sign-in + ruoli staff, onboarding + T&C (`register_guest`), cassa ricarica (`topup`).
- **M2 Bar loop** — `consume` (listino Normale/Premium), menù consultabile (`drinks.visibile/attivo`), crescita totem, realtime ospite.
- **M3 Sessioni tap** — `set_phase`, `start_session`/`register_taps`/`close_session`, arena tap, classifica live regia, anti-cheat.
- **M4 Finale** — `LAST_CALL` + `convert_credit` (modale irreversibile) + `run_draw` + reveal vincitore.
- **M5 Hardening** — idempotenza end-to-end, resilienza offline cassa, riconciliazione, gestione menù/prezzi da dashboard (`update_event_settings`/`upsert_drink`/…), QA su device reali, deploy.

# OUTPUT ATTESO (in questo turno)
1. `PLAN.md` completo: fasi → sprint → task con `(id, descrizione, agente owner, dipendenze design/code, parallelizzabile sì/no, riferimenti Spec Pack/RPC, criteri di accettazione, gate di test)`.
2. Un **grafo delle dipendenze** + una **matrice di assegnazione agente↔task**.
3. Un **registro rischi** + lista **Open Questions** da chiarire con me.
4. La proposta del **primo sprint** (M1-S1) pronto da avviare.

Poi **FERMATI**: niente codice di feature finché non approvo il piano. Se qualcosa è ambiguo, elenca le **OQ** invece di assumere.
