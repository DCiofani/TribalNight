# Totem Night — Spec-Guardian Report

> Output di **@spec-guardian** (team hull). Fonte di verità: `docs/totem-night-spec-pack.md` + `docs/totem-night_db_schema.sql`. Vedi [`PLAN.md`](../../PLAN.md).

---

## Validation summary

## Validation summary — backbone vs fonte di verità

Ho verificato i 5 milestone / 67 task del backbone contro: schema SQL (autoritativo, 14 RPC + 3 helper), Spec Pack §1–§13, flussi.md (mappa 1:1), branding.md, T&C BOZZA.

**Esito globale: il backbone è sostanzialmente conforme.** Tutte e 14 le RPC sono coperte da almeno un task; i 3 helper (`app_role`/`is_staff`/`totem_level`) sono citati; la macchina a fasi e le precondizioni RPC sono riportate correttamente nei task di analisi (es. T-M3-01 riporta esattamente la formula anti-cheat `v_allow`/`v_cap` e `close_session floor(min(tap,cap)/ticket_ogni)`; T-M2-01 riporta `livello_totem = totem_level(count+1)`; T-M4-01 deriva correttamente la tabella fase→RPC).

**Punti di forza:**
- La regola d'oro (schema §0: scritture SOLO via RPC SECURITY DEFINER, niente ricalcolo client) è ribadita e gated in T-M1-14, T-M2-11, T-M3-13, T-M5-13.
- Idempotenza correttamente differenziata: `topup`/`consume` su PK `transactions.id`=idem; `convert_credit` su esistenza `tipo='conversione'` per guest (T-M5-02 lo annota esplicitamente come possibile gap, corretto).
- `register_taps` correttamente: ticket NON assegnati qui, solo a `close_session` (T-M3-09 lo dice, vincolo 6).
- Provably-fair: seed+pool_snapshot persistiti, pool ordinato per id, senza reimmissione (T-M4-02/09/12, T-M5-05) — fedele a §4.9 schema.

**Problemi rilevati (dettaglio in `gaps`):**
1. Citazioni a sezioni Spec Pack inesistenti / spostate: il backbone cita ripetutamente §7.5 e §7.6 come se fossero sezioni dello Spec Pack, ma nello **Spec Pack** la conversione finale è §7.5 (esiste) e l'estrazione §7.6 (esiste) — OK. Tuttavia diversi task M4/M5 citano "§8 estrazione provably-fair" e "§7 conversione" mescolando numerazione Spec Pack e flussi.md (dove l'estrazione è §8 e la conversione §7). Ambiguità di riferimento, non bloccante ma da disambiguare.
2. `transactions.tipo` ha **4 valori** (`ricarica,consumo,conversione,tap`), ma Spec Pack §6 ne elenca solo 3 (manca `tap`). Lo schema è autoritativo; i task che parlano di "transactions tipo='tap'" (T-M3-05/12, T-M5-04) sono corretti rispetto allo schema ma divergono dal §6 dello Spec Pack.
3. Helper `totem_level` ha firma `totem_level(int)` (conta consumazioni), ma alcuni task lo trattano come fonte del livello 0-6 generico — corretto, nessun errore sostanziale.
4. ID dipendenze incoerenti tra milestone: M2/M3 usano placeholder `T-M1-SCHEMA`/`T-M1-RLS` mentre il task reale è `T-M1-03` (schema) e `T-M1-09` (RLS). Disallineamento di riferimenti che può rompere il grafo dipendenze.
5. `max_tap_al_secondo` vive **anche** su `tap_sessions` (snapshot al lancio), non solo su `events`: i task anti-cheat (T-M3-08, T-M5-04) citano solo `events.max_tap_al_secondo`; il clamp runtime usa `tap_sessions.max_tap_al_secondo`. Da precisare per i test.

Nessun gap blocca l'inizio del build di M1; i gap di numerazione/riferimento e gli Open Items §13 vanno chiusi prima di M4/M5.

## Copertura RPC

## Copertura RPC → task

| RPC (schema §4) | Firma | Task che la coprono | Stato |
|---|---|---|---|
| `register_guest(uuid,text)` | §4.1 | T-M1-07, T-M1-10, T-M5-11 | Coperta bene (idempotenza + consenso_tos_at) |
| `topup(uuid,text,int,numeric,uuid)` | §4.2 | T-M1-08, T-M1-11, T-M4-04, T-M5-02, T-M5-03 | Coperta bene (gating APERTA, idem, importo_euro, operatore) |
| `consume(uuid,uuid,uuid)` | §4.3 | T-M2-01, T-M2-04, T-M2-06, T-M2-10, T-M4-04, T-M5-02, T-M5-03 | Coperta bene |
| `convert_credit(uuid,uuid)` | §4.4 | T-M4-02, T-M4-06, T-M4-07, T-M4-08, T-M5-02 | Coperta bene (idempotenza su tipo='conversione') |
| `set_phase(uuid,text)` | §4.5 | T-M3-04, T-M3-06, T-M4-01, T-M4-03, T-M5-14 | Coperta bene |
| `start_session(uuid,int)` | §4.6 | T-M3-01, T-M3-04, T-M3-05, T-M3-06 | Coperta bene (una sola active, fase APERTA) |
| `register_taps(uuid,int,int)` | §4.7 | T-M3-01, T-M3-05, T-M3-08, T-M3-09, T-M3-11, T-M5-04 | Coperta bene (clamp/cap) |
| `close_session(uuid)` | §4.8 | T-M3-01, T-M3-05, T-M3-08, T-M5-04 | Coperta bene (idempotenza, ticket solo qui) |
| `run_draw(uuid,int,double)` | §4.9 | T-M4-02, T-M4-09, T-M4-12, T-M5-05 | Coperta bene (determinismo, no reimmissione) |
| `update_event_settings(...)` | §4.10 | T-M5-08, T-M5-09 | Coperta — **solo M5**, nessuna analisi backend dedicata (no backend-analyst task); CRUD parametri evento appare tardi |
| `upsert_drink(...)` | §4.11 | T-M2-02, T-M2-04, T-M2-07, T-M5-08, T-M5-09 | Coperta bene |
| `set_drink_visibility(uuid,bool)` | §4.12 | T-M2-02, T-M2-04, T-M2-07, T-M5-09 | Coperta bene |
| `set_drink_active(uuid,bool)` | §4.13 | T-M2-02, T-M2-04, T-M2-07, T-M5-09 | Coperta bene |
| `delete_drink(uuid)` | §4.14 | T-M2-02, T-M2-04, T-M2-07, T-M5-09 | Coperta bene |
| **Helper** `app_role()` | §1 | T-M1-05, T-M5-13 (implicito via is_staff) | Coperta debolmente (mai testata isolatamente) |
| **Helper** `is_staff(text)` | §1 | T-M1-05, T-M1-09, e tutti i gating ruolo | Coperta bene |
| **Helper** `totem_level(int)` | §1 | T-M2-01, T-M2-08, T-M2-10, T-M3-10 | Coperta bene (mappa 0-6) |

**RPC non coperte:** nessuna — tutte e 14 hanno almeno 1 task.

**Coperte male / da rinforzare:**
- `update_event_settings`: nessun task di analisi contratto dedicato (a differenza di consume/convert_credit/run_draw che hanno backend-analyst). Compare solo come item della dashboard M5. Manca verifica del comportamento `coalesce` (aggiorna solo campi passati) e del gating solo-regia in un contract test dedicato prima di M5-S2.
- `app_role()`: mai oggetto di un test isolato; testato solo indirettamente tramite `is_staff`. Accettabile ma da notare.
- `register_taps` clamp: i test (T-M3-08, T-M5-04) citano `events.max_tap_al_secondo` ma il clamp runtime legge `tap_sessions.max_tap_al_secondo` (snapshot al lancio). Coperta ma con riferimento alla colonna sbagliata.