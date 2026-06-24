# TOTEM NIGHT — Pacchetto di sviluppo (handoff per Claude Code)

App per evento tribale: ogni ospite ha un **totem** sul telefono che cresce a ogni consumazione; consumi e **sessioni di tap** a tempo accumulano **ticket**; a fine serata **estrazione pesata** sui ticket. Credito prepagato in due tipi di consumazione (Normale/Premium), pagamento alla cassa, conversione del residuo in ticket nel finale.

## File del pacchetto

| File | Cosa contiene | Ruolo |
|---|---|---|
| `totem-night-spec-pack.md` | Concept, attori, fasi, economia, modello dati, stack, milestone, compliance | **Spec Pack** (lo leggono gli agenti hull) |
| `totem-night_db_schema.sql` | Schema Postgres + 14 funzioni RPC (+3 helper) + RLS + grants (verificato col parser PG) | **Fonte di verità** dati e regole |
| `totem-night_flussi.md` | Diagrammi Mermaid: ruoli, macchina a fasi, 6 sequenze | Allineamento flussi |
| `totem-night_termini-e-condizioni_BOZZA.md` | T&C + regolamento estrazione + privacy (bozza) | Testo onboarding (da validare) |
| `totem-night_branding.md` | Direzione visiva (baseline da @edenjoinus, da ricolorare) | Branding placeholder |
| `totem-night_PROMPT-plan.md` | Prompt da incollare in Claude Code per generare il `PLAN.md` multi-agente | **Kickoff** del piano |

## Fonte di verità
Lo **schema SQL** è il riferimento autorevole: dati, regole ticket, autorizzazioni per ruolo, fasi e idempotenza vivono lì (funzioni `SECURITY DEFINER`). Il front-end **non** calcola mai saldi o ticket: chiama le RPC e ascolta il Realtime.

Tutti i parametri (prezzi, ticket, durate) e il **menù** sono gestibili a runtime dalla dashboard regia: `update_event_settings`, `upsert_drink`, `set_drink_visibility`, `set_drink_active`, `delete_drink`. Nessun deploy per cambiare un prezzo o nascondere un cocktail. Il menù mostra all'ospite solo le voci con `visibile = true`.

## Sviluppo multi-agente (hull)
Lo sviluppo va fatto con la skill **`hull`**, che installa in `.claude/agents/` un equipaggio di 10 sub-agent Claude Code (orchestrator, plan-architect, spec-guardian, analyst + implementer backend/frontend, integration-specialist, test-strategist, code-reviewer) che leggono lo **Spec Pack** come fonte di verità.

1. Metti questi file in `docs/` del repo. Gli agenti cercano `*spec-pack*.md` → `totem-night-spec-pack.md` è già nominato giusto.
2. Verifica che la skill/plugin **hull** sia installata nel tuo Claude Code (stesso marketplace di Cowork). Senza, gli agenti non si installano.
3. Invoca `hull` ("installa gli agenti"), poi **riavvia Claude Code** e controlla con `/agents`.
4. Tratta `totem-night_db_schema.sql` come il **contratto tecnico autoritativo**: le RPC + RLS sono la spec del backend.
5. Lavora a milestone (M1→M5): es. `@plan-architect proponi la decomposizione della M1`, poi gli implementer.

👉 Per avviare, incolla in Claude Code il contenuto di `totem-night_PROMPT-plan.md`: fa generare un `PLAN.md` completo dell'intera piattaforma e si ferma prima del codice per la tua approvazione.

## Prerequisiti Supabase
1. Attivare **Anonymous sign-in** (ogni telefono = un ospite).
2. Assegnare allo staff il claim `app_metadata.role` ∈ `cassa` / `regia` / `admin` (via Admin API/dashboard).
3. Applicare `totem-night_db_schema.sql` come migrazione.

## Stack di riferimento
Next.js (App Router) PWA mobile-first · Supabase (Postgres + Realtime + RLS) · Stripe o POS/contanti per le ricariche · route `/onboarding` `/guest` `/cassa` `/regia`.

## Ordine di build (milestone)
1. **M1 Fondamenta** — applicare schema, auth (anon + ruoli staff), onboarding/consenso, ricarica.
2. **M2 Bar loop** — `consume` (listino Normale/Premium), crescita totem, Realtime sull'ospite.
3. **M3 Sessioni tap** — fasi, `start_session`/`register_taps`/`close_session`, arena tap, classifica live, anti-cheat.
4. **M4 Finale** — `LAST_CALL` + `convert_credit` (modale irreversibile) + `run_draw` + reveal.
5. **M5 Hardening** — idempotenza end-to-end, resilienza offline cassa, riconciliazione, QA su device reali.

## Da fissare prima di partire
- Numeri definitivi (prezzi €, ticket per tipo, durata/numero sessioni) — tutti nella tabella `events`.
- Premi, numero vincitori, regole di ritiro.
- Branding e identità visiva tribale.
- **Totem in-app**: per la demo usare un **modello di totem africano** placeholder, strutturato come componente sostituibile (l'asset definitivo verrà fornito).
- ⚠️ **Validazione legale** dell'estrazione (DPR 430/2001) e dell'informativa privacy (GDPR) con un consulente.

## Primo prompt suggerito per Claude Code
> «In `docs/` trovi lo Spec Pack (`totem-night-spec-pack.md`), lo schema Postgres `totem-night_db_schema.sql` (fonte di verità: RPC + RLS) e i diagrammi. Usa la skill **`hull`** per installare il team di sub-agent, poi sviluppa a milestone. Stack: Next.js (App Router) PWA + Supabase (Anonymous sign-in, ruoli staff via `app_metadata.role`, applica lo schema come migrazione). Il front-end non ricalcola mai saldi/ticket: chiama le RPC e ascolta il Realtime. Per il totem usa un **modello di totem africano demo** come placeholder sostituibile. Il branding è placeholder: tieni colori e nome in token di tema. Parti dalla **M1**; prima di scrivere codice, fammi 3–5 domande e proponi il piano.»
