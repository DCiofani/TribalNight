# Totem Night — Checklist Review Trasversale

> Output di **@code-reviewer** (team hull). Fonte di verità: `docs/totem-night-spec-pack.md` + `docs/totem-night_db_schema.sql`. Vedi [`PLAN.md`](../../PLAN.md).

---

# Totem Night — Checklist di review trasversale (code-reviewer / hull)

> Fonte di verità: `totem-night_db_schema.sql`. Citazioni per nome RPC e § spec-pack/flussi. Il front-end NON ricalcola mai saldi/ticket; ogni scrittura passa dalle 14 RPC SECURITY DEFINER.

## 1. Idempotenza (§5, §7.2/§7.3/§7.5)
- [ ] `topup`: `p_idem` = `transactions.id` (PK); retry stesso idem ritorna la transaction esistente (schema §4.2, riga 280-283). VERIFICATO nel codice.
- [ ] `consume`: idem early-return su `transactions where id = p_idem` (§4.3, riga 325-326). VERIFICATO.
- [ ] `convert_credit`: ATTENZIONE — il guard di unicità NON è su `p_idem` ma su `exists(tipo='conversione' for guest)` (§4.4, riga 396-399). `p_idem` è usato solo nell'INSERT. Verificare che un retry con **idem diverso** dopo successo NON crei doppia conversione (protetto dal guard exists + `FOR UPDATE` su guest riga 383) e che un retry con **stesso idem** non sollevi PK-violation (il guard exists intercetta prima dell'insert → OK solo se la prima è committata).
- [ ] `close_session`: idempotente via `if v_s.stato='closed' then return 0` + guard `r.ticket_assegnati = 0` (§4.8, riga 539, 545). VERIFICATO no doppio accredito.
- [ ] `register_taps`: upsert su `(session_id, guest_id)` con clamp; NON ha idem key — retry batch raddoppia il `tap_count`? Verificare che il batching client invii **delta**, non cumulativo, e che il cap `v_cap` assorba eventuali doppi invii (§4.7, riga 513-517).
- [ ] Client: UUID idem generato lato client e **persistito** (IndexedDB) finché la RPC non conferma; lo stesso idem riusato su ogni retry; idem MAI riusato tra operazioni diverse.

## 2. Race condition su saldi/ticket — FOR UPDATE (§5)
- [ ] `topup`/`consume`/`convert_credit`: `select ... for update` sulla riga `guests` PRIMA di leggere/scrivere saldo (righe 285, 328, 383). VERIFICATO row-lock presente.
- [ ] `topup`: l'idem-check (riga 280) avviene PRIMA del `FOR UPDATE`; due chiamate concorrenti stesso idem possono entrambe superare il check → seconda INSERT fallisce su PK. Verificare che il client gestisca l'errore PK come "già applicata" (riconciliazione via SELECT) e non come errore bloccante.
- [ ] `consume`: `livello_totem = totem_level(consumazioni_count + 1)` legge il valore sotto lock — coerente (riga 347). VERIFICATO no lost-update sul totem.
- [ ] `close_session`: `select ... for update` sulla `tap_sessions` (riga 537) serializza doppia chiusura. VERIFICATO.
- [ ] CHECK constraint `saldo_normale >= 0` / `saldo_premium >= 0` (righe 96-97) come rete di sicurezza contro saldo negativo concorrente.

## 3. RLS / sicurezza per ruolo (§9)
- [ ] Default-deny: nessuna policy INSERT/UPDATE/DELETE su nessuna tabella (riga 220). VERIFICATO.
- [ ] `guests_select`: ospite vede solo `auth_uid = auth.uid()` o staff (riga 203-204). Verificare che la riga `guests` esposta includa `pin` e `auth_uid` — non leakarli oltre il proprietario/staff.
- [ ] `drinks_select`: ospite vede solo `visibile=true`; staff tutto (riga 197-198). VERIFICATO separazione visibile vs attivo.
- [ ] `tx_select`/`taps_select`: subquery `guest_id in (select ... where auth_uid = auth.uid())` (righe 207-218). VERIFICATO scoping ospite.
- [ ] `app_role()` legge `request.jwt.claims -> app_metadata -> role`; default `'guest'`. Verificare che `app_metadata.role` sia settato in `app_metadata` (immutabile dal client) e NON in `user_metadata` (modificabile dall'utente).
- [ ] `is_staff('regia')` gating su tutte le RPC di regia: `set_phase`, `start_session`, `close_session`, `run_draw`, `update_event_settings`, `upsert_drink`, `set_drink_visibility`, `set_drink_active`, `delete_drink`. VERIFICATO presente in ognuna.
- [ ] `topup`/`consume` gated `is_staff()` (cassa o regia o admin); `convert_credit` consente `is_staff() OR auth_uid = auth.uid()` (riga 386). VERIFICATO.
- [ ] Grants: `execute` solo ad `authenticated` (riga 759); `anon` ha solo `usage on schema`. Verificare che l'ospite faccia anonymous sign-in (diventa `authenticated`) prima di chiamare RPC.

## 4. Rate-limit / anti-cheat tap (§5, §4.7)
- [ ] `v_allow = ceil(greatest(elapsed_ms,250)/1000 * max_tap) + max_tap` (riga 508): `p_elapsed_ms` è **client-supplied e non validato** contro `started_at`/wall-clock server. Un client può inviare molte chiamate con `elapsed_ms` minimo, ognuna concedendo un burst pieno.
- [ ] `v_cap = durata_s * max_tap_al_secondo` (riga 511): tetto cumulativo sull'INTERA sessione — protegge il numero massimo di ticket anche se elapsed_ms è falsificato. VERIFICATO il cap regge contro autoclicker.
- [ ] Ticket assegnati SOLO a `close_session` (`floor(min(tap,cap)/ticket_ogni)`, riga 542-543); mai in `register_taps`. VERIFICATO.
- [ ] `register_taps` rifiuta `stato<>'active'` o `now() > ends_at` (riga 499). VERIFICATO tap fuori finestra respinti.
- [ ] Verificare assenza tetto per-call indipendente da elapsed_ms falso: il cap di sessione è l'unica difesa reale → confermare che è accettabile (fairness "skill" non garantita, ma ticket sì).

## 5. Gating di fase (§3, §7)
- [ ] `topup`/`consume`: solo `fase='APERTA'` (righe 289, 332). VERIFICATO.
- [ ] `convert_credit`: solo `LAST_CALL` (riga 391). VERIFICATO.
- [ ] `run_draw`: solo `ESTRAZIONE` (riga 588). VERIFICATO.
- [ ] `start_session`: solo `APERTA` + una sola sessione `active` (righe 459-465). VERIFICATO.
- [ ] `set_phase`: NESSUNA validazione di transizione — consente salti arbitrari (es. CHIUSA→APERTA, ESTRAZIONE→APERTA), riga 439. Verificare se la macchina a fasi (§3 SETUP→APERTA→LAST_CALL→ESTRAZIONE→CHIUSA) va enforced server-side o solo UI.
- [ ] `close_session`: regia-only ma NESSUN check di fase — chiudibile in qualsiasi fase (riga 535). Confermare comportamento atteso.
- [ ] Fase letta dal client SOLO via Realtime/SELECT su `events.fase`, mai stato ottimistico locale non riconciliato.

## 6. Gestione errori RPC lato client
- [ ] Mappare le eccezioni Postgres a messaggi UI: "saldo insufficiente", "fase errata", "non staff/regia", "drink non valido", "ospite inesistente", "nessun credito da convertire", "sessione non attiva".
- [ ] Distinguere errori **retriabili** (rete) da **non-retriabili** (saldo insufficiente, fase) — i non-retriabili escono dalla coda offline senza bloccare le operazioni successive.
- [ ] PK-violation su retry `topup`/`consume` con stesso idem va trattata come "già applicata" (no doppio addebito), non come errore fatale.

## 7. Immutabilità ledger (§5)
- [ ] `transactions` append-only: nessuna policy UPDATE/DELETE; `id` = idem key PK (riga 127). VERIFICATO.
- [ ] Ogni `topup`/`consume`/`convert_credit`/`tap` produce una riga; `consume` registra `note=drink.nome`, `tap` registra `note='sessione <id>'` (righe 363, 553). VERIFICATO traccia audit.
- [ ] `convert_credit` registra `qta_delta = -(norm+prem)` e `ticket_delta` in UNA riga aggregata (riga 421) — la spec §7.5 dice "transaction per ciascun tipo"; confermare se una riga aggregata è accettabile per la riconciliazione.

## 8. Seed / estrazione verificabile (§7.6, §4.9)
- [ ] `run_draw` salva `seed`, `pool_snapshot` (ordinato per id), `winners` (righe 632-633). VERIFICATO persistenza audit.
- [ ] `pool_snapshot` è preso dai `guests` LIVE al momento del draw, non da uno stato congelato precedente; la verifica provably-fair è "replay esterno di seed+snapshot", NON "ri-chiamata di run_draw" (che rileggerebbe guests live, potenzialmente cambiati). Documentare la procedura di verifica.
- [ ] `setseed(v_seed)` + `random()` in loop con pool `order by id`: la riproducibilità dipende dalla sequenza esatta di chiamate `random()`. Verificare con test che stesso seed + stesso snapshot ⇒ stessi winners (determinismo).
- [ ] Senza reimmissione: `update _pool set tickets=0` sul vincitore (riga 625); `v_n = least(p_n_winners, count(*))` clampa (riga 614); `v_total=0 → raise` (riga 612). VERIFICATO.
- [ ] `draws_select` to authenticated using(true) (riga 200): TUTTI gli autenticati leggono seed+winners+snapshot — accettabile per trasparenza, ma `pool_snapshot` contiene `nome` ospiti (PII minima). Confermare.

## 9. PWA / offline (§5, §9, M5)
- [ ] Coda offline cassa (`topup`/`consume`): persistenza locale, drenaggio FIFO con backoff, idem key stabile per operazione.
- [ ] Conferma sempre server-authoritative (saldo/ticket da ritorno RPC o Realtime, mai calcolati client).
- [ ] Alla riconnessione Realtime: re-fetch stato corrente (saldi/ticket/fase/menu) come source-of-truth invece di fidarsi di eventi persi; re-subscribe automatico canali.
- [ ] Service worker / manifest installabile; nessun saldo/ticket persistito come verità nel client.

## 10. Leak PII in realtime / log (§11 GDPR)
- [ ] Canale `guest:state` = row-change su `guests`: la riga include `pin` e `auth_uid`. RLS limita al proprietario, ma verificare che il payload Realtime rispetti la RLS (filtro per riga) e non broadcasti `pin` ad altri.
- [ ] `admin:stats` / `session:leaderboard` (staff): esporre solo `nome` + conteggi, NON `pin`/`auth_uid`.
- [ ] `transactions.note` non deve contenere PII oltre nome drink / id sessione (verificato nelle RPC).
- [ ] `consenso_tos_at` valorizzato a `register_guest` (riga 246-251) — presente per audit GDPR; nessuna PII oltre `nome`.
- [ ] Log applicativi/observability: nessun `pin`, `auth_uid` o JWT in chiaro.
