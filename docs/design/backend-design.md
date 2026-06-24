# Totem Night — Backend Design (per milestone)

> Output di **@backend-analyst** (team hull). Fonte di verità: `docs/totem-night-spec-pack.md` + `docs/totem-night_db_schema.sql`. Vedi [`PLAN.md`](../../PLAN.md).

---

# TOTEM NIGHT — Backend Design Doc (per milestone)

> Autore: @backend-analyst (hull). Fonte di verità: `docs/totem-night_db_schema.sql` (autoritativo), `docs/totem-night-spec-pack.md`, `docs/totem-night_flussi.md`.
> Regola d'oro (schema §0, CLAUDE.md vincolo 1): saldi/ticket/esiti si muovono **solo** tramite le 14 RPC `SECURITY DEFINER`. Le tabelle non concedono INSERT/UPDATE/DELETE: la RLS lascia ai client **solo SELECT mirate**. Il front-end **non ricalcola mai** nulla; legge righe e si fida del server. Lo schema **non si ridisegna**: le proposte sotto sono marcate `[PROPOSTA — additiva, non in M1]`.
>
> **Dove vivono i numeri.** Tutti i parametri economici e anti-cheat stanno in `events` (prezzi, `ticket_consumo_*`, `ticket_conversione_*`, `tap_ticket_ogni`, `durata_sessione_s`, `max_tap_al_secondo`). Le RPC li leggono a runtime; il client non deve hardcodare un solo numero. `start_session` **fotografa** i parametri tap in `tap_sessions` (`durata_s`, `ticket_ogni`, `max_tap_al_secondo`) → la chiusura usa i valori della sessione, non quelli correnti di `events`.

---

## Mappa RPC → fase → ruolo (tabella autoritativa, derivata dallo schema)

| RPC | Ruolo richiesto | Fase richiesta | Idempotenza | Milestone |
|---|---|---|---|---|
| `register_guest(p_event, p_nome)` | autenticato (anche anon) | nessuna | lookup `(event_id, auth_uid)` | M1 |
| `topup(p_guest, p_tipo, p_qta, p_importo, p_idem)` | `is_staff()` | **APERTA** | PK `transactions.id = p_idem` | M1 |
| `consume(p_guest, p_drink, p_idem)` | `is_staff()` | **APERTA** | PK `transactions.id = p_idem` | M2 |
| `upsert_drink(...)` | `is_staff('regia')` | nessuna | n/a (upsert su `p_id`) | M2/M5 |
| `set_drink_visibility(p_drink, p_visibile)` | `is_staff('regia')` | nessuna | naturale (set assoluto) | M2/M5 |
| `set_drink_active(p_drink, p_attivo)` | `is_staff('regia')` | nessuna | naturale (set assoluto) | M2/M5 |
| `delete_drink(p_drink)` | `is_staff('regia')` | nessuna | naturale (delete) | M2/M5 |
| `set_phase(p_event, p_phase)` | `is_staff('regia')` | nessuna (set assoluto) | naturale | M3 (intro), M4 (fasi finali) |
| `start_session(p_event, p_durata?)` | `is_staff('regia')` | **APERTA** + nessuna sessione `active` | guardia "una sola active" | M3 |
| `register_taps(p_session, p_count, p_elapsed_ms)` | autenticato (l'ospite del proprio guest) | sessione `active` e `now() <= ends_at` | upsert `(session_id, guest_id)` + clamp/cap | M3 |
| `close_session(p_session)` | `is_staff('regia')` | sessione non già `closed` | early-return su `stato='closed'` + guardia `ticket_assegnati=0` | M3 |
| `convert_credit(p_guest, p_idem)` | `is_staff()` **o** `auth_uid = auth.uid()` | **LAST_CALL** | guardia `exists(tx tipo='conversione')` per guest | M4 |
| `run_draw(p_event, p_n_winners, p_seed?)` | `is_staff('regia')` | **ESTRAZIONE** | **non idempotente** (ogni call crea una riga `draws`) | M4 |
| `update_event_settings(p_event, ...)` | `is_staff('regia')` | nessuna | naturale (`coalesce` per campo) | M5 (uso pieno) |

`admin` passa sempre `is_staff()` e `is_staff('regia')` (vedi `is_staff`: `admin → true`). `cassa` passa `is_staff()` ma **non** `is_staff('regia')`.

---

## RLS coinvolta (vale trasversalmente, tutte le milestone)

- `events_select`, `sessions_select`, `draws_select`: SELECT a **qualsiasi authenticated** (`using (true)`). Fase, sessioni e estrazioni sono pubbliche tra i loggati.
- `drinks_select`: `visibile = true OR is_staff()` → l'ospite vede **solo le voci visibili**; lo staff tutto. (Nota: il filtro `attivo` per la cassa è applicativo, non RLS.)
- `guests_select`: `auth_uid = auth.uid() OR is_staff()` → l'ospite vede **solo sé stesso**; lo staff tutti.
- `tx_select` / `taps_select`: `is_staff() OR guest_id ∈ (i propri guests)`.
- **Nessuna policy INSERT/UPDATE/DELETE** su nessuna tabella → ogni scrittura diretta è negata; passano solo le RPC `SECURITY DEFINER` (che girano come owner, bypassando la RLS in modo controllato). Test trasversale: scrittura diretta da ospite **e** da staff → entrambe negate.

---

# M1 — Fondamenta (schema, auth, onboarding, wallet/ricarica)

## RPC che sono il contratto
**`register_guest(p_event uuid, p_nome text) → public.guests`**
- Precondizioni: `auth.uid()` non null (anonymous sign-in dell'ospite); altrimenti `raise 'autenticazione richiesta'`.
- Effetti: se esiste già una riga `(event_id, auth_uid)` la **ritorna invariata** (idempotenza naturale, niente duplicati grazie a `unique(event_id, auth_uid)`); altrimenti inserisce con `nome = coalesce(nullif(trim,''),'Ospite')`, `pin = lpad(4 cifre)`, `consenso_tos_at = now()`, `last_seen = now()`, saldi/ticket/totem inizializzati a 0/default.
- **Nota di contratto importante**: `register_guest` **non ha `p_idem`** — l'idempotenza è data dal lookup, non dalla idem-key. Il front-end non deve passare idem qui.
- **Compliance**: `consenso_tos_at` è valorizzato al momento della registrazione → la conferma T&C deve precedere la chiamata (il client non chiama `register_guest` finché l'ospite non accetta). Per audit basta `select consenso_tos_at`.

**`topup(p_guest, p_tipo, p_qta, p_importo, p_idem) → public.transactions`**
- Precondizioni in ordine: `is_staff()` (cassa/regia/admin); `p_tipo ∈ {normale,premium}`; `p_qta > 0`; **idempotenza** (`select … where id = p_idem` → return early); `guest` esistente con `FOR UPDATE`; `events.fase = 'APERTA'` (altrimenti `raise` con la fase corrente).
- Effetti atomici: incrementa `saldo_normale` **oppure** `saldo_premium` di `p_qta` (mai entrambi); inserisce `transactions(tipo='ricarica', tipo_consumazione=p_tipo, qta_delta=p_qta, ticket_delta=0, importo_euro=p_importo, operatore=auth.uid())`.
- **Riconciliazione**: `importo_euro` è popolato **solo** sulle ricariche → la quadratura cassa somma `transactions(tipo='ricarica').importo_euro` per `operatore` e `tipo_consumazione`.
- **Idempotenza**: la idem-key UUID è generata dal client e usata come **PK** della transaction. Retry di rete con stesso `p_idem` → ritorna la transaction esistente, **nessun secondo accredito** (il `FOR UPDATE` e l'`update` saldo vengono saltati dal return early).

## Gating fase
Solo `topup` è gated a `APERTA` in M1. Test gate: `topup` in SETUP/LAST_CALL/ESTRAZIONE/CHIUSA → eccezione, saldo invariato.

## RLS coinvolta
`guests_select` (ospite vede sé), `tx_select`, `events_select`, `drinks_select`. Il flusso realtime `guest:state` = subscription Postgres-changes su `public.guests` filtrata dalla RLS (l'ospite riceve solo la propria riga) → saldo aggiornato sul telefono dopo `topup`.

## Migrazione
Schema applicato come **migrazione singola idempotente** (tutto `create … if not exists` / `create or replace`). DoD: 7 tabelle, 3 helper, 14 RPC, indici, RLS, grants `execute` ad `authenticated`. Re-run senza errori. Introspezione: 14 RPC presenti + grant.

## Viste/funzioni mancanti — proposte M1
- `[PROPOSTA — additiva, non in M1]` **Vista lista-ospiti per cassa** (`v_cassa_guests`): la cassa già legge `guests` via RLS, ma per UX serve una proiezione leggera (`id, nome, pin, saldo_normale, saldo_premium`) e ricerca per `nome`/`pin`. Si può fare lato client con `select` mirata; **non serve nuova RPC**. Rimando a M2 (dove la cassa risolve l'ospite).

---

# M2 — Bar loop (consume, menù, totem, realtime)

## RPC che sono il contratto
**`consume(p_guest, p_drink, p_idem) → public.transactions`**
- Precondizioni in ordine: `is_staff()`; **idempotenza** (`id = p_idem` → return early); `guest` con `FOR UPDATE`; `events.fase = 'APERTA'`; drink valido = `drinks where id=p_drink and event_id = guest.event_id and attivo` (il filtro `attivo` è server-side, non solo UI).
- Effetti per tipo del drink:
  - `normale`: se `saldo_normale < 1` → `raise 'saldo NORMALE insufficiente'`; altrimenti `saldo_normale -= 1`, `ticket_consumo += events.ticket_consumo_normale` (default 4), `consumazioni_count += 1`, `livello_totem = totem_level(consumazioni_count + 1)`.
  - `premium`: simmetrico con `events.ticket_consumo_premium` (default 8) e `saldo_premium`.
- Inserisce `transactions(tipo='consumo', tipo_consumazione=v_d.tipo, qta_delta=-1, ticket_delta=v_tickets, operatore=auth.uid(), note=v_d.nome)`.
- **Saldo per tipo**: scala **solo** il saldo del tipo del drink; i due saldi non sono intercambiabili.
- **Totem**: `livello_totem = totem_level(consumazioni_count + 1)` — usa `+1` perché legge la riga *prima* dell'incremento; mappa 0-6: `0=0, 1≥1, 2≥2, 3≥5, 4≥8, 5≥12, 6≥20`. I **ticket da tap/conversione non muovono il totem** (dipende solo da `consumazioni_count`).
- **Idempotenza**: identica a `topup` (PK = `p_idem`). Stesso idem → una sola riga, un solo decremento.

## RPC gestione menù (contratto regia)
- **`upsert_drink(p_event, p_id, p_nome, p_tipo, …, p_visibile, p_attivo)`**: `is_staff('regia')`; `p_tipo ∈ {normale,premium}`; `p_id is null` → **insert** nuova voce, altrimenti **update** vincolato a `id=p_id AND event_id=p_event` (se non trova → `raise`).
- **`set_drink_visibility(p_drink, p_visibile)`** / **`set_drink_active(p_drink, p_attivo)`**: `is_staff('regia')`, set assoluto del flag.
- **`delete_drink(p_drink)`** → `void`; `is_staff('regia')`.
- **Semantica `visibile` vs `attivo`** (due assi indipendenti):
  - `visibile` = compare nel **menù ospite** (governato da `drinks_select`).
  - `attivo` = **ordinabile alla cassa** (filtro applicativo + check server in `consume`).
  - Filtri di query derivati: ospite → `visibile = true` (RLS-enforced); cassa → `attivo = true` (applicativo); regia → tutto.

## Gating fase
`consume` solo in `APERTA`. Le RPC menù **non** sono gated a fase (la regia può gestire il listino in SETUP). Test: `consume` fuori APERTA → respinto.

## RLS coinvolta
`drinks_select` (ospite solo `visibile`), `guests_select`, `tx_select`. Realtime: `guest:state` (riga `guests`) + subscription a `drinks` per propagare cambi `visibile`/`attivo` a `/guest` e `/cassa`.

## Viste/funzioni mancanti — proposte M2
- `[PROPOSTA — additiva, non in M2]` Nessuna RPC nuova necessaria per il bar loop: il contratto è completo. La risoluzione ospite via QR/PIN alla cassa è **SELECT** (consentita allo staff da `guests_select`), non una RPC. Eventuale helper di ricerca lato server è opzionale e rimandabile.

---

# M3 — Sessioni tap (arena, classifica, anti-cheat)

## RPC che sono il contratto
**`set_phase(p_event, p_phase) → public.events`** (introdotta qui): `is_staff('regia')`; `p_phase` nel set enumerato; set assoluto di `events.fase`. Server-authoritative: la fase live si legge da `events` via realtime, non da stato ottimistico client.

**`start_session(p_event, p_durata?) → public.tap_sessions`**: `is_staff('regia')`; `events.fase = 'APERTA'`; **una sola sessione `active`** per evento (altrimenti `raise 'chiudi prima…'`). Fotografa `durata_s = coalesce(p_durata, events.durata_sessione_s)`, `ticket_ogni = events.tap_ticket_ogni`, `max_tap_al_secondo = events.max_tap_al_secondo`, `ends_at = now() + durata_s`.

**`register_taps(p_session, p_count, p_elapsed_ms) → public.taps`** (chiamata dall'ospite):
- Precondizioni: `auth.uid()` non null; `p_count >= 0`; sessione esistente con `stato='active'` e `now() <= ends_at`; guest risolto da `auth_uid + event_id` (l'ospite **deve** essere registrato — dipendenza M1/M2).
- **Anti-cheat (formula esatta dallo schema)**:
  - `v_allow = ceil(greatest(elapsed_ms, 250)/1000 * max_tap_al_secondo) + max_tap_al_secondo` → tetto **per singola chiamata** (rate plausibile + 1s di burst). `elapsed_ms` mancante/0 trattato come 250ms minimo.
  - `v_cap = durata_s * max_tap_al_secondo` → tetto **cumulativo di sessione**.
  - Upsert su `(session_id, guest_id)`: insert `least(p_count, v_allow, v_cap)`; on-conflict `tap_count = least(tap_count + least(p_count, v_allow), v_cap)`.
- **I ticket NON vengono assegnati qui.** `register_taps` accumula solo `tap_count`. Un autoclicker non supera mai `v_cap`.

**`close_session(p_session) → int`** (totale ticket assegnati): `is_staff('regia')`; sessione con `FOR UPDATE`; se `stato='closed'` → **return 0** (idempotente). Per ogni riga `taps`: `v_tickets = floor(least(tap_count, durata_s*max_tap_al_secondo) / ticket_ogni)`; se `> 0` **e** `ticket_assegnati = 0` (doppia guardia) → setta `ticket_assegnati`, `guests.ticket_tap += v_tickets`, inserisce `transactions(tipo='tap', ticket_delta=v_tickets, note='sessione …')`. Infine `stato='closed'`, `closed_at=now()`.
- **Idempotenza**: duplice — early-return su `closed` + guardia `ticket_assegnati = 0` per riga. **Attenzione di contratto**: la transaction `tap` usa `gen_random_uuid()` come PK (non una idem-key client), quindi l'idempotenza di `close_session` **non** dipende da una idem-key ma dallo stato della sessione/riga. Corretto perché solo la regia chiude e l'early-return previene la doppia esecuzione.

## Gating fase + ruoli
`start_session`/`register_taps` operativi solo con sessione `active` (che esiste solo se lanciata in APERTA). `set_phase`/`start_session`/`close_session` = **solo regia**. L'ospite può **solo** `register_taps` per il proprio guest. Test: ospite che chiama `start_session`/`close_session` → respinto.

## RLS coinvolta
`sessions_select` (tutti i loggati vedono le sessioni → arena e countdown), `taps_select` (ospite i propri / staff tutti → la classifica regia legge tutti i `taps`), `guests_select`.

## Realtime
- `event:phase` (riga `events`), `session:state` (riga `tap_sessions` active→closed), `session:leaderboard` = aggregazione `taps` per guest ordinata desc, **throttled/coalesced** (~2-4 update/s) lato regia. Il countdown si sincronizza su `ends_at`.

## Viste/funzioni mancanti — proposte M3
- `[PROPOSTA — additiva, non in M3]` **Vista leaderboard server-side** (`v_session_leaderboard(session_id)`): aggregazione `taps`→`guests.nome` ordinata per `tap_count desc`. Riduce join lato client e centralizza l'ordinamento. **Non bloccante**: la regia può aggregare via SELECT su `taps` (RLS staff = tutti) + join `guests`. Marcata come ottimizzazione, non requisito.

---

# M4 — Finale (LAST_CALL, conversione, estrazione, CHIUSA)

## RPC che sono il contratto
**`convert_credit(p_guest, p_idem) → public.guests`**:
- Autorizzazione: `is_staff() OR guests.auth_uid = auth.uid()` (l'ospite converte sé stesso, oppure lo staff per lui). Guest con `FOR UPDATE`.
- Fase: `events.fase = 'LAST_CALL'` (altrimenti `raise`).
- **Idempotenza (doppio meccanismo, da capire bene)**:
  1. Guardia **funzionale**: `if exists(tx where guest_id=p_guest and tipo='conversione') then return v_g` → una sola conversione per ospite, **anche con `p_idem` diverso**. Questa è la vera barriera "una volta sola".
  2. Guardia **PK**: la transaction inserita usa `id = p_idem`. Un retry con **stesso** `p_idem` colpisce prima la guardia funzionale (return early) → niente errore di PK duplicata né doppio accredito.
  - `[NOTA tecnica per M5-02]` Se due richieste concorrenti con `p_idem` diversi arrivassero **prima** che la prima committi, il `FOR UPDATE` sul guest le serializza: la seconda vede la transaction già inserita e ritorna. Race risolta dal lock di riga.
- Effetti: legge `v_norm = saldo_normale`, `v_prem = saldo_premium`; se `v_norm+v_prem = 0` → `raise 'nessun credito da convertire'`; `v_tickets = v_norm*ticket_conversione_normale + v_prem*ticket_conversione_premium` (default 5/10); azzera entrambi i saldi, `ticket_conversione += v_tickets`; inserisce `transactions(tipo='conversione', qta_delta=-(norm+prem), ticket_delta=v_tickets, note='convertite norm:.. prem:..')`.

**`run_draw(p_event, p_n_winners, p_seed?) → public.draws`**:
- `is_staff('regia')`; `events.fase = 'ESTRAZIONE'`; `p_n_winners >= 1`.
- **Provably-fair / determinismo**: `v_seed = coalesce(p_seed, random())` → **persistito** in `draws.seed`. `perform setseed(v_seed)`. Pool **deterministico** = `guests where event_id and ticket_totali > 0 order by id`, fotografato in `pool_snapshot` (jsonb ordinato per id). Estrazione **pesata sui ticket, senza reimmissione** (`update _pool set tickets=0` sul vincitore). `v_n = least(p_n_winners, count(pool))` (clamp). Se `v_total = 0` → `raise 'nessun ticket in gioco'`.
- **Riproducibilità**: stesso `seed` **e** stesso pool (stessi `ticket_totali` per gli stessi id) → stessi `winners`. Verifica ex-post: ri-eseguire l'algoritmo con `draws.seed` e `draws.pool_snapshot`. Il client **non sorteggia**: legge solo `draws.winners`.
- **`run_draw` non è idempotente**: ogni chiamata crea una nuova riga `draws`. Il client deve impedire doppio lancio (gating UI in ESTRAZIONE + conferma). Test: stesso seed + stesso pool ⇒ stesso esito; seed assente ⇒ seed comunque persistito.

**`set_phase`** (riuso da M3): pilota `LAST_CALL → ESTRAZIONE → CHIUSA`.

## Gating fase (tabella autoritativa fase→RPC)
- `APERTA`: `{topup, consume, start_session, register_taps, close_session}`.
- `LAST_CALL`: `{convert_credit}` — `topup`/`consume` respinti server-side (bar e ricariche OFF); la UI deve disabilitarli ma il server è la barriera vera.
- `ESTRAZIONE`: `{run_draw}`.
- `CHIUSA`: **nessuna mutante** — `topup`/`consume`/`convert_credit`/`run_draw` sollevano tutte per fase non valida. Stato terminale read-only; `set_phase` resta tecnicamente eseguibile dalla regia (non gated a fase) ma le viste sono read-only.

## RLS coinvolta
`draws_select` (tutti i loggati vedono l'esito → reveal), `guests_select` (saldi azzerati/ticket post-conversione via `guest:state`), `tx_select`.

## Realtime
`event:phase`, `guests` (post-conversione), `draws` (insert → reveal regia, eventualmente ospite).

## Viste/funzioni mancanti — proposte M4
- `[PROPOSTA — additiva, non in M4]` **Funzione di verifica draw** (`verify_draw(draw_id) → jsonb`): ri-esegue l'algoritmo deterministico su `seed`+`pool_snapshot` salvati e confronta con `winners` per audit "provably-fair" senza fidarsi del client. **Non bloccante**: la verifica è già possibile riproducendo l'algoritmo esternamente con i dati in chiaro di `draws`. Utile per trasparenza post-evento.

---

# M5 — Hardening (idempotenza E2E, coda offline, riconciliazione, dashboard)

## Contratto (review, non nuove RPC)
Nessuna RPC nuova richiesta. M5 blinda i contratti esistenti:
- **Idempotenza E2E**: la idem-key UUID è **generata dal client** e **persistita localmente** finché la RPC non conferma. `topup`/`consume` la usano come PK transaction → replay sicuro (ritorna la transaction esistente). `convert_credit` è idempotente per ospite (guardia `tipo='conversione'`) **indipendentemente** dalla idem-key — quindi la coda offline può ritrasmettere senza rischio anche con idem diversa (ma il client dovrebbe riusare la stessa per coerenza del ledger).
- **Coda offline cassa**: dispatcher FIFO persistente (IndexedDB/localStorage) con `{op, payload, idem, stato, attempt, ts}`. Errori **non-retriabili** (saldo insufficiente, fase errata, non-staff) escono dalla coda con messaggio; errori di rete → retry/backoff con **stessa** idem. Lo stato mostrato è sempre server-authoritative (ritorno RPC o realtime), mai ricalcolato.
- **Anti-cheat tap** e **provably-fair draw**: re-verificati come test gate (clamp `v_allow`/cap `v_cap`, ticket solo a `close_session`; seed+snapshot riproducibili).

## Riconciliazione cassa (sola lettura)
- Aggregazione su `transactions` (append-only) via RLS staff (`tx_select`), **nessuna nuova RPC di scrittura**:
  - Euro incassati = `sum(importo_euro) where tipo='ricarica'` raggruppato per `tipo_consumazione` e `operatore`.
  - Gettoni venduti per tipo = `sum(qta_delta) where tipo='ricarica'` per `tipo_consumazione`.
  - Consumi/conversioni dal ledger per audit.
- Export CSV lato client; differenza dichiarato-vs-ledger calcolata in UI. Accesso negato a ospite/cassa per la vista riconciliazione (gate UI + RLS già garantisce che l'ospite non vede tx altrui).

## Dashboard regia (5 RPC)
`update_event_settings` (coalesce per campo, solo i passati cambiano → niente sovrascrittura accidentale; solo regia) + `upsert_drink`/`set_drink_visibility`/`set_drink_active`/`delete_drink`. Propagazione realtime: cambi `drinks` → menù ospite (`visibile`) e listino cassa (`attivo`); cambi `events` → prezzi/ticket senza ricalcolo client (le RPC li rileggono).

## Compliance tecnica
`consenso_tos_at` loggato in onboarding (M1) → interrogabile per audit (no PII oltre `nome`/`pin`). Ogni `draws` conserva `seed + pool_snapshot + winners`. Ogni accredito tap genera `transactions(tipo='tap')`. Ogni ricarica conserva `importo_euro` + `operatore`.

## Viste/funzioni mancanti — proposte M5 (le più sostanziali)
- `[PROPOSTA — additiva, non in M5]` **Vista riconciliazione** `v_reconciliation(event_id)`: incapsula l'aggregazione `transactions(ricarica)` per `tipo_consumazione`/`operatore` (euro + gettoni) + conteggi consumi/conversioni. Sola lettura, governata da `tx_select` (staff). Vantaggio: centralizza la logica di quadratura ed evita query ad-hoc divergenti lato client. **Non obbligatoria** (fattibile con SELECT), ma raccomandata per consistenza dell'export.
- `[PROPOSTA — additiva, non in M5]` **Vista/funzione `admin:stats`** (`v_admin_stats(event_id)`): lo spec-pack §8 cita il canale `admin:stats` (presenze, gettoni venduti, ticket totali) ma **nello schema non esiste alcuna sorgente aggregata** per esso. Proposta: vista che espone `count(guests)`, `sum(saldo_*)`/`sum(qta_delta ricarica)`, `sum(ticket_totali)`, partecipanti con ticket>0. Sola lettura, staff. **Gap reale rispetto allo spec** — senza questa, `admin:stats` va costruito client-side aggregando `guests`/`transactions` (possibile via RLS staff, ma pesante e non throttle-friendly). Da valutare con spec-guardian se promuoverla a requisito M5.

---

## Sintesi gap/rischi da portare a spec-guardian (nessuna modifica schema senza approvazione)
1. **`admin:stats` senza sorgente** (spec §8): manca una vista aggregata. Workaround client-side possibile; proposta vista additiva.
2. **`run_draw` non idempotente**: per design (audit trail di ogni draw). Il client deve prevenire doppio lancio; nessuna fix di schema necessaria, solo gating UI.
3. **`convert_credit` doppia idempotenza** (PK idem + guardia funzionale): coerente e sicuro sotto `FOR UPDATE`; documentato per M5-02, nessun gap.
4. **`close_session` tx con `gen_random_uuid()`**: idempotenza garantita da stato sessione, non da idem-key — corretto perché solo-regia.
5. **Determinismo `run_draw`**: riproducibile solo a parità di seed **e** pool; `pool_snapshot` lo cattura → audit ok. Il riordino fisso `order by id` è essenziale e già presente.

Tutte le proposte sopra sono **additive e marcate**; lo schema `totem-night_db_schema.sql` resta la fonte di verità e non va ridisegnato.