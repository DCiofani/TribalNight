# Totem Night — Strategia Test & Gate CI

> Output di **@test-strategist** (team hull). Fonte di verità: `docs/totem-night-spec-pack.md` + `docs/totem-night_db_schema.sql`. Vedi [`PLAN.md`](../../PLAN.md).

---

# Totem Night — Strategia di Test & Gate CI (@test-strategist)

> Fonte di verità: `docs/totem-night_db_schema.sql` (autoritativo). Nessun ricalcolo client; tutte le scritture passano dalle 14 RPC SECURITY DEFINER. Stato live via Realtime. Repo attualmente greenfield (solo `docs/` + `.claude/`): questa strategia definisce anche lo stack di test da erigere.

## 0. Stack di test (da erigere — non esiste ancora codice/CI nel repo)

| Livello | Tool | Scopo |
|---|---|---|
| Contract RPC + RLS + idempotenza + anti-cheat + draw | **pgTAP** (su Postgres) eseguito via `supabase db` su DB Postgres effimero, OPPURE **Vitest + supabase-js** con `setRole`/JWT custom | Verità server-side. Preferito pgTAP per asserzioni `throws_ok` su messaggi di eccezione esatti + isolamento transazionale per test. Vitest+supabase-js per i casi che richiedono `auth.uid()`/claim JWT realistici (RLS, register_taps, register_guest, convert_credit self). |
| Unit FE (wrapper RPC, mapping errori, idem-key, coda offline) | **Vitest** + jsdom | Mapping errori Postgres→UI, generazione/persistenza idem UUID, FIFO della coda offline. |
| Component (Totem 0-6, reveal) | **Vitest + Testing Library** + snapshot | Isolamento Totem, mappa livello→stato visivo. |
| E2E multi-ruolo + realtime + PWA + offline | **Playwright** (3 storage-state: ospite anon, cassa, regia) contro stack effimero (Supabase locale in CI) | Loop completi, realtime <2s, gating UI, coda offline cassa. |
| Device reali | **Playwright device emulation** (iOS Safari/WebKit + Android Chrome) in CI + **checklist manuale** su device fisici per M5 | PWA installabile, airplane-mode mid-operation. |

Helper di test condivisi:
- `jwtFor(role)` → genera JWT con `app_metadata.role ∈ {cassa,regia,admin}` o anon (guest) per pilotare `app_role()`/`is_staff()`/`auth.uid()`.
- `freshEvent(fase)`, `seedDrinks()`, `makeGuest(authUid)` — fixture deterministiche.
- `idem()` → UUID v4 client-side riusato sui retry.

---

## 1. Contract test — tutte le 14 RPC (input/output/errori/gating fase)

Asserire SEMPRE: (a) effetto su tabella (riga/delta esatti), (b) ritorno della RPC, (c) eccezione con **messaggio esatto** dello schema per ogni ramo di errore. I numeri (ticket/prezzi/durate) si leggono da `events`, mai hardcoded nei test (default schema: consumo 4/8, conversione 5/10, tap_ticket_ogni 10, durata 30s, max_tap 12).

### register_guest(p_event, p_nome)
- Happy: anon con `auth.uid()` → crea 1 riga; `consenso_tos_at = now()` non-null; `pin` 4 cifre `lpad`; saldi/ticket/consumazioni = 0; `livello_totem` 0; `ticket_totali` (colonna generata) = 0.
- Idempotenza: seconda chiamata stesso `(event_id, auth_uid)` → ritorna **stessa riga**, nessun duplicato (vincolo `unique(event_id, auth_uid)`).
- Errore: `auth.uid()` null → `'autenticazione richiesta'`.
- Nome vuoto/whitespace → fallback `'Ospite'` (coalesce/nullif/trim).

### topup(p_guest, p_tipo, p_qta, p_importo, p_idem)
- Happy normale/premium in fase APERTA → `saldo_<tipo> += p_qta`; transaction `tipo='ricarica'`, `tipo_consumazione=p_tipo`, `qta_delta=p_qta`, `ticket_delta=0`, `importo_euro=p_importo`, `operatore=auth.uid()`.
- Gating fase: in SETUP/LAST_CALL/ESTRAZIONE/CHIUSA → `'ricariche disabilitate nella fase %'`.
- Autorizzazione: non-staff → `'operazione riservata allo staff (cassa/regia)'`.
- Validazione: `p_tipo ∉ {normale,premium}` → `'tipo consumazione non valido: %'`; `p_qta null/<=0` → `'quantità non valida'`.
- Ospite inesistente → `'ospite inesistente'`.
- Idempotenza: stesso `p_idem` → ritorna transaction esistente, **nessun secondo accredito** (verificare saldo invariato).
- Riconciliazione: somma `importo_euro` per `tipo_consumazione`/`operatore` coerente con N chiamate.

### consume(p_guest, p_drink, p_idem)
- Happy normale: `saldo_normale -=1`, `ticket_consumo += ticket_consumo_normale`, `consumazioni_count++`, `livello_totem = totem_level(count+1)`; transaction `tipo='consumo'`, `tipo_consumazione='normale'`, `qta_delta=-1`, `ticket_delta=4`, `note=drink.nome`.
- Happy premium: analogo con `saldo_premium`, ticket 8. **Verificare che scali SOLO il saldo del tipo del drink.**
- Saldo 0 del tipo → `'saldo NORMALE insufficiente'` / `'saldo PREMIUM insufficiente'`; nessuna mutazione.
- Gating fase ≠ APERTA → `'bar non operativo nella fase %'`.
- Drink non attivo / event_id diverso / inesistente → `'drink non valido o non attivo'`.
- Non-staff → riservato allo staff.
- Idempotenza: stesso `p_idem` → 1 sola transaction, 1 solo decremento, totem non riavanza.

### convert_credit(p_guest, p_idem)
- Happy solo in LAST_CALL: `ticket_conversione += norm*ticket_conversione_normale + prem*ticket_conversione_premium`; saldi azzerati; transaction `tipo='conversione'`, `qta_delta=-(norm+prem)`.
- Gating fase ≠ LAST_CALL → `'conversione disponibile solo nel LAST_CALL (fase attuale: %)'`.
- Autorizzazione: staff OK; **self (auth_uid=auth.uid()) OK**; ospite altrui → `'non autorizzato'`.
- Credito 0 → `'nessun credito da convertire'`.
- Idempotenza (una volta per ospite): guard su `exists transaction tipo='conversione'`. **Caso limite da verificare**: seconda chiamata con **idem diverso** ritorna la riga guest senza nuova conversione (early-return prima dell'insert → niente errore di PK duplicata). Seconda chiamata con **stesso idem** → idem path (early-return su tipo='conversione' precede l'insert).

### set_phase(p_event, p_phase)
- Happy regia/admin → `events.fase` aggiornata e persistita; ritorna riga.
- Valori invalidi → `'fase non valida: %'`.
- Non-regia (cassa/ospite/admin? — admin passa via `is_staff('regia')` perché admin=true) → cassa/ospite → `'solo regia'`.
- Evento inesistente → `'evento inesistente'`.

### start_session(p_event, p_durata?)
- Happy regia in APERTA → riga `tap_sessions` `stato='active'`, `durata_s=coalesce(p_durata, durata_sessione_s)`, `ends_at=now()+durata`, copia `ticket_ogni`/`max_tap_al_secondo` da events.
- Fase ≠ APERTA → `'le sessioni si lanciano solo a evento APERTA'`.
- Sessione active già esistente → `'chiudi prima la sessione attiva (close_session)'`.
- Non-regia → `'solo regia'`; evento inesistente → `'evento inesistente'`.

### register_taps(p_session, p_count, p_elapsed_ms) — vedi §4 anti-cheat
- Happy: upsert su `(session_id, guest_id)`; clamp applicato.
- Errori: anon null → `'autenticazione richiesta'`; `p_count null/<0` → `'count non valido'`; sessione inesistente → `'sessione inesistente'`; sessione `closed` o `now()>ends_at` → `'sessione non attiva'`; guest non registrato per l'evento → `'ospite non registrato per questo evento'`.

### close_session(p_session) — vedi §3 idempotenza
- Happy regia: per ogni tap `ticket = floor(least(tap_count, durata_s*max_tap)/ticket_ogni)`; se `>0 e ticket_assegnati=0` → set `ticket_assegnati`, `guests.ticket_tap +=`, transaction `tipo='tap'`, `ticket_delta>0`, `note='sessione <id>'`. Ritorna somma ticket.
- Idempotenza: sessione già `closed` → ritorna **0**, nessun doppio accredito.
- Non-regia → `'solo regia'`; sessione inesistente → `'sessione inesistente'`.

### run_draw(p_event, p_n_winners, p_seed?) — vedi §5 riproducibilità
- Happy ESTRAZIONE → riga `draws` con `seed`, `pool_snapshot` (ordinato per id), `winners`.
- Fase ≠ ESTRAZIONE → `'imposta la fase ESTRAZIONE prima del sorteggio'`.
- `p_n_winners null/<1` → `'numero vincitori non valido'`.
- Pool 0 ticket → `'nessun ticket in gioco'`.
- Non-regia → `'solo regia'`; evento inesistente → `'evento inesistente'`.

### update_event_settings(...)
- Happy regia: solo i campi non-null aggiornati (coalesce); altri invariati. Ritorna riga.
- Non-regia → `'solo regia/admin'`; evento inesistente → `'evento inesistente'`.

### upsert_drink(...)
- Insert (p_id null) → nuova voce con default visibile/attivo true.
- Update (p_id set) → modifica voce stesso `event_id`; id+event_id non corrispondenti → `'voce di menù inesistente'`.
- `p_tipo ∉ {normale,premium}` → `'tipo non valido: %'`; non-regia → `'solo regia/admin'`.

### set_drink_visibility(p_drink, p_visibile) / set_drink_active(p_drink, p_attivo)
- Happy regia → toggle del campo; ritorna riga. Inesistente → `'voce di menù inesistente'`. Non-regia → `'solo regia/admin'`.

### delete_drink(p_drink)
- Happy regia → riga eliminata (`void`). Non-regia → `'solo regia/admin'`.

---

## 2. Test RLS per ruolo (ospite vede solo sé; staff vede tutto; scritture dirette negate)

Eseguire con JWT/role reali (ospite anon con `auth.uid()`, cassa, regia, admin). Default-deny: nessuna policy INSERT/UPDATE/DELETE.

**SELECT — ospite:**
- `guests`: solo riga con `auth_uid = auth.uid()` (policy `guests_select`); 0 righe altrui.
- `transactions`: solo proprie (`tx_select` via subquery guest); 0 righe altrui.
- `taps`: solo propri (`taps_select`); 0 righe altrui.
- `drinks`: solo `visibile=true` (`drinks_select`); voci `visibile=false` non visibili.
- `events`/`tap_sessions`/`draws`: leggibili (policy `using(true)` per authenticated).

**SELECT — staff (cassa/regia/admin):**
- `guests`/`transactions`/`taps`: **tutte** le righe (ramo `is_staff()`).
- `drinks`: **tutto** il listino incl. `visibile=false`.

**Scritture dirette negate (ospite E staff):**
- `INSERT/UPDATE/DELETE` diretto su `guests, events, drinks, transactions, tap_sessions, taps, draws` → respinto (nessuna policy di scrittura). Verificare con ruolo `authenticated` (non service_role). Conferma chiave del vincolo "server-authoritative".

---

## 3. Idempotenza (retry stesso idem)

Pattern comune: ripetere la stessa chiamata con identico idem e asserire **un solo effetto** (1 transaction, 0 doppio delta).

- **topup**: 2x stesso `p_idem` → 1 transaction (PK = idem), saldo incrementato 1 sola volta.
- **consume**: 2x stesso `p_idem` → 1 transaction, 1 decremento, `consumazioni_count`/`livello_totem` non avanzano due volte.
- **convert_credit**: 2x (stesso idem) → guard `tipo='conversione'` → no doppio accredito; **anche con idem diverso** → no seconda conversione (guard sul tipo, non sull'idem). Casi entrambi obbligatori.
- **close_session**: 2a chiamata → ritorna 0, `ticket_tap`/`ticket_assegnati`/transaction non duplicati.
- **register_taps**: retry con `elapsed_ms` basso → upsert non gonfia oltre clamp/cap (vedi §4).
- **FE coda offline (M5)**: drenaggio coda con idem stabile per operazione → riconnessione non duplica; idem **non riusato tra operazioni diverse**.

---

## 4. Anti-cheat tap (clamp rate, tetto sessione, ticket solo a close_session)

Formule autoritative dallo schema:
- `v_allow = ceil(greatest(elapsed_ms,250)/1000 * max_tap_al_secondo) + max_tap_al_secondo` (per chiamata).
- `v_cap = durata_s * max_tap_al_secondo` (cumulativo sessione).
- insert iniziale: `tap_count = least(p_count, v_allow, v_cap)`; on-conflict: `tap_count = least(tap_count + least(p_count, v_allow), v_cap)`.

Test:
- **Clamp per-chiamata**: `p_count` enorme (es. 99999) con `elapsed_ms=1000`, `max_tap=12` → tap_count clampato a `v_allow = 12+12 = 24`.
- **Clamp `elapsed_ms` floor 250**: `elapsed_ms=0/null` → usa 250ms → `v_allow = ceil(0.25*12)+12 = 3+12 = 15`.
- **Tetto sessione**: invii ripetuti che sommerebbero oltre `durata_s*max_tap` (30*12=360) → tap_count plafonato a 360.
- **Ticket SOLO a close_session**: prima di close, `guests.ticket_tap = 0` e `taps.ticket_assegnati = 0`; dopo close `= floor(min(tap_count,cap)/ticket_ogni)`.
- **Fuori finestra**: register_taps dopo `ends_at` o su sessione `closed` → `'sessione non attiva'` (race close-vs-tap: la chiusura prevale, tap tardivi non producono ticket extra).

---

## 5. Estrazione riproducibile (stesso seed+snapshot → stesso esito)

- **Determinismo**: due `run_draw` con **stesso seed** sullo **stesso pool** (stessi `ticket_totali`, stesso ordinamento per id) → `winners` identici (provably-fair). `perform setseed(seed)` + pool ordinato per id.
- **Seed assente** → seed casuale comunque **persistito** in `draws.seed` (verificabilità ex-post).
- **Senza reimmissione**: nessun `guest_id` ripetuto nei winners (`update _pool set tickets=0`).
- **Clamp n_winners**: `p_n_winners > |pool con ticket>0|` → `n_winners` clampato al numero di partecipanti (`least(p_n_winners, count(*))`).
- **Pesatura**: distribuzione dei winners su molte run con seed diversi coerente con i pesi `ticket_totali` (test statistico soft, non bloccante).
- **Audit**: `pool_snapshot` ordinato per id e coerente con `ticket_totali` al momento del sorteggio.
- RLS: ospite non può chiamare run_draw (`'solo regia'`); `draws` leggibile da tutti gli authenticated (reveal).

---

## 6. E2E su device (PWA, offline cassa)

- **Loop bar (M2)**: onboarding+T&C → topup cassa → scan/PIN → consume normale+premium → ticket+totem corretti → guest UI aggiornata via `guest:state` **<2s** senza reload.
- **Sessione tap (M3)**: 2+ ospiti + 1 regia → start_session → tap (countdown su `ends_at`) → leaderboard live throttled → close_session → `ticket_tap` accreditati realtime.
- **Coda finale (M4)**: APERTA→LAST_CALL (bar/ricariche OFF, gating UI per i 3 ruoli) → convert_credit one-shot (modale doppio-step irreversibile) → ESTRAZIONE → run_draw + reveal (legge solo `draws.winners`) → CHIUSA read-only (RPC mutanti respinte server-side).
- **PWA installabile**: manifest + service worker registrato; Lighthouse PWA smoke; iOS Safari/WebKit + Android Chrome.
- **Offline cassa (M5)**: airplane-mode mid-operation → topup/consume accodati FIFO → riconnessione → drenaggio con idem stabile → **nessun doppio addebito**; UI stato coda (pending/in-volo/confermato/errore); errori non-retriabili (saldo insufficiente, fase) escono dalla coda senza bloccare.
- **Realtime resilienza (M5)**: drop/recover connessione → re-subscribe automatico + re-fetch stato come source-of-truth (no saldi stale).
- **Compliance**: `consenso_tos_at` non-null per ogni ospite; ogni accredito tap/ricarica/consumo/conversione ha riga `transactions` per audit; `draws` conserva seed+snapshot+winners.

---

## 7. Principi invarianti verificati trasversalmente (gate di review)

1. Nessun `INSERT/UPDATE/DELETE` diretto dal client — solo le 14 RPC.
2. Il FE non ricalcola mai saldi/ticket/esito sorteggio — legge solo righe (`guests`, `draws`) via RLS.
3. Gating fase enforced server-side (test contract) **e** UI (test e2e), mai solo UI.
4. Idem key UUID client-side, persistita finché la RPC non conferma, non riusata tra operazioni.
5. Token branding in `:root`, nome app in config (no hardcode) — check in code-review.

---

## 8. Mappatura ai test_gates del backbone

- **M1**: T-M1-03 (migrazione clean+idempotente+introspezione 14 RPC/grants) · T-M1-07 (contract register_guest, idempotenza, consenso non-null) · T-M1-08 (contract topup, idempotenza retry, gating fase, riconciliazione importo_euro) · T-M1-09 (RLS ospite/staff + deny scritture dirette) · T-M1-10/11/12 (e2e onboarding, ricarica, realtime guest:state).
- **M2**: T-M2-01 (contract consume happy+errori) · T-M2-02 (RLS drinks visibile, upsert/visibility/active/delete solo-regia) · T-M2-04 (idempotenza retry consume, mapping errori) · T-M2-10 (e2e bar loop multi-fase, idempotenza retry consume, RLS ruoli, totem_level 0-6).
- **M3**: T-M3-04 (set_phase valori validi/invalidi, RLS ospite vs regia, gating start_session) · T-M3-05/08 (contract register_taps/close_session, idempotenza close, anti-cheat clamp/cap, ticket solo a close) · T-M3-12 (e2e multi-client, audit ledger tap, checklist gating).
- **M4**: T-M4-08 (contract convert_credit, idempotenza retry, RLS self/staff/altrui) · T-M4-12 (determinismo seed, no reimmissione, clamp n_winners, 0 ticket, RLS run_draw solo regia) · T-M4-13 (e2e coda serata multi-ruolo, suite M4, idempotenza, determinismo).
- **M5**: T-M5-02/04/05 (hardening idempotenza, anti-cheat, provably-fair) · T-M5-03/10 (offline queue drain, realtime reconnect resync) · T-M5-09 (contract 5 RPC menù/settings, RLS cassa) · T-M5-12 (e2e onboarding-to-draw, offline, anti-cheat su device) · T-M5-14 (post-deploy smoke).


## Gate CI

| Gate | Blocca | Tool |
|---|---|---|
| migration_apply | Merge bloccato se la migrazione singola (totem-night_db_schema.sql) non si applica clean su Postgres fresco, non e idempotente alla ri-esecuzione, o l'introspezione non trova 7 tabelle + 3 helper + 14 RPC + grant execute ad authenticated. | supabase CLI (db reset/push) o psql -f su Postgres effimero (container); query introspezione su pg_proc/information_schema; pgTAP has_function/has_table |
| contract_rpc | Merge bloccato se un contract test su una delle 14 RPC fallisce: effetto su tabella, valore di ritorno, o messaggio di eccezione esatto per ogni ramo (gating fase, autorizzazione ruolo, validazione input). | pgTAP (throws_ok/results_eq) su DB effimero, oppure Vitest + supabase-js con JWT per-ruolo |
| rls_per_role | Merge bloccato se l'ospite legge dati altrui (guests/transactions/taps) o drink non visibili, se lo staff non vede tutto, o se una scrittura diretta INSERT/UPDATE/DELETE da ruolo authenticated NON viene respinta. | Vitest + supabase-js con storage-state/JWT per ruolo (anon ospite, cassa, regia, admin); pgTAP con set role |
| idempotency | Merge bloccato se un retry con stesso idem su topup/consume/convert_credit produce piu di una transaction o un doppio delta, se close_session ripetuta non ritorna 0/duplica ticket, o se la coda offline FE duplica su riconnessione. | pgTAP/Vitest (retry assertions su count transactions e delta saldi); Playwright per coda offline FE |
| anticheat_tap | Merge bloccato se register_taps non clampa a v_allow per-chiamata o a v_cap=durata_s*max_tap cumulativo, se i ticket vengono assegnati prima di close_session, o se tap fuori finestra (closed/oltre ends_at) non sono respinti. | pgTAP/Vitest contract test con max_tap_al_secondo controllato da fixture events |
| draw_reproducible | Merge bloccato se due run_draw con stesso seed+pool non producono winners identici, se il seed non viene persistito quando assente, se c'e reimmissione (winner ripetuto), o se n_winners non e clampato/0-ticket non solleva. | pgTAP/Vitest determinismo (doppia run, confronto winners + seed persistito + pool_snapshot ordinato per id) |
| lint_build | Merge bloccato se lint o build Next.js PWA falliscono, o se Lighthouse PWA smoke (installabilita: manifest + service worker) non passa. | ESLint, next build, Lighthouse CI (smoke) |
| e2e_multirole | Merge bloccato (su milestone gate) se un flusso e2e multi-ruolo fallisce: bar loop con realtime guest:state <2s, sessione tap multi-client, coda serata LAST_CALL->ESTRAZIONE->CHIUSA con gating UI, o coda offline cassa con doppio-addebito. | Playwright (3 storage-state ospite/cassa/regia, device emulation iOS WebKit + Android Chrome) contro Supabase locale effimero in CI |
| compliance_audit | Merge bloccato (milestone gate M4/M5) se consenso_tos_at risulta null per un ospite registrato, se un accredito tap/ricarica/consumo/conversione non ha riga transactions, o se un draw non conserva seed+pool_snapshot+winners. | Query asserzioni su transactions/guests/draws in pgTAP/Vitest; eseguito nel job e2e |
| post_deploy_smoke | Promozione a produzione bloccata se lo smoke post-deploy fallisce: anonymous sign-in ospite, topup/consume da cassa in APERTA, set_phase da regia, run_draw in ESTRAZIONE, health/version. | Playwright smoke + script health-check (git_sha/version) contro l'ambiente deployato |
