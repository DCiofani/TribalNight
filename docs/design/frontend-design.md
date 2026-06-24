# Totem Night — Frontend Design (per milestone)

> Output di **@frontend-analyst** (team hull). Fonte di verità: `docs/totem-night-spec-pack.md` + `docs/totem-night_db_schema.sql`. Vedi [`PLAN.md`](../../PLAN.md).

---

# TOTEM NIGHT — Frontend Design Doc (alto livello, per milestone M1→M5)

> **Owner:** @frontend-analyst · **Fonte di verità:** `totem-night_db_schema.sql` (autoritativo), `totem-night-spec-pack.md`, `totem-night_flussi.md`, `totem-night_branding.md`.
> **Stato:** design PRIMA del codice. Nessun artefatto FE ancora esistente nel repo.
>
> **REGOLA D'ORO FE (vincolo 1):** il front-end **non ricalcola mai** saldi/ticket/livello/esito-sorteggio. Ogni numero mostrato proviene da una riga letta via SELECT (RLS) o da un push Realtime. Ogni scrittura passa **solo** dalle 14 RPC `SECURITY DEFINER`. I valori "stimati" mostrati all'utente (es. ticket previsti in conversione) sono **decorativi**, mai persistiti, mai trattati come verità.

---

## 0. Principi architetturali trasversali (validi M1→M5)

### 0.1 Stato lato client = solo cache di dati server
Il client mantiene tre tipi di stato, **nessuno dei quali è autoritativo**:
1. **Server cache** — copie di righe Supabase (`events`, `guests`, `drinks`, `tap_sessions`, `taps`, `draws`, `transactions`) lette via SELECT RLS-filtrata, sovrascritte dai push Realtime.
2. **UI/ephemeral** — input form, modali aperte, tab attiva, countdown locale (derivato da `ends_at`), contatore tap ottimistico locale (puramente visivo, mai inviato come ticket).
3. **Outbox/idempotenza** — coda di chiamate RPC mutanti con `idem` UUID stabile (introdotta in forma minima da M1, hardened in M5).

**Mai nello stato client:** logica che produce un saldo/ticket/livello come "fonte". Il livello totem viene da `guests.livello_totem`; i ticket da `guests.ticket_*`; l'esito sorteggio da `draws.winners`.

### 0.2 Layer di accesso dati (`/lib`)
```
/lib
  config.ts          → APP_NAME, EVENT_ID corrente, feature flags, fallback-polling toggle
  theme.ts           → re-export token (i colori vivono in :root, vedi §0.6)
  supabase/client.ts → singleton browser client (anon key)
  supabase/auth.ts   → anonymousSignIn(), ensureSession(), readRole() (da app_metadata.role)
  rpc/*.ts           → un wrapper TIPATO per ogni RPC (firma 1:1 con lo schema)
  rpc/errors.ts      → mappa messaggi Postgres → messaggi UI localizzati (it)
  realtime/*.ts      → un hook per canale (vedi §0.4)
  outbox/*.ts        → coda idempotente (stub M1 → completa M5)
```
**Regola wrapper RPC:** ogni wrapper invoca `supabase.rpc(<nome>, {...})`, ritorna la riga restituita e **non** esegue alcun calcolo di gioco. La generazione di `idem` (UUID v4 client-side) vive qui per `topup`/`consume`/`convert_credit`.

### 0.3 Mappa errori RPC → UI (centralizzata, `rpc/errors.ts`)
Gli errori sollevati dalle RPC sono stringhe note dallo schema. Esempi di mapping (estendere per milestone):
| Eccezione RPC (schema) | Messaggio UI (it) | Comportamento |
|---|---|---|
| `operazione riservata allo staff` | "Azione non consentita" | toast, nessun retry |
| `ricariche disabilitate nella fase X` / `bar non operativo nella fase X` | "Bar chiuso · fase X" | disabilita controllo, no retry |
| `saldo NORMALE/PREMIUM insufficiente` | "Saldo {tipo} esaurito" | toast, no retry |
| `drink non valido o non attivo` | "Drink non disponibile" | refetch menù |
| `conversione disponibile solo nel LAST_CALL` | "Conversione non ancora aperta" | disabilita CTA |
| `nessun credito da convertire` | "Nessun credito da convertire" | mostra stato già-vuoto |
| `sessione non attiva` | "Sessione conclusa" | chiudi arena |
| `solo regia` / `solo regia/admin` | "Solo Regia" | nascondi/disabilita |
| `imposta la fase ESTRAZIONE prima del sorteggio` | "Passa a ESTRAZIONE" | guida UI |
| `nessun ticket in gioco` | "Nessun ticket nel pool" | blocca estrazione |
errori di **rete/timeout** → retriabili dall'outbox con stesso `idem`; errori **di dominio** (sopra) → non retriabili, escono dalla coda.

### 0.4 Hook Realtime — uno per canale (§8 spec-pack)
Tutti gli hook: subscribe su mount, **teardown su unmount**, RLS-aware (ricevono solo righe consentite), **resync via SELECT alla riconnessione** (la verità è la riga, non l'evento), fallback **polling** se Realtime non disponibile (`config.ts`).

| Canale logico (§8) | Sorgente Supabase (tabella/righe) | Sottoscrittori | Hook | Milestone |
|---|---|---|---|---|
| `event:phase` | `events` (row UPDATE su `fase`) per `event_id` | guest, cassa, regia | `useEventPhase(eventId)` | M1 (intro) → usato in tutte |
| `guest:state` | `guests` (row UPDATE) filtrata `auth_uid = auth.uid()` (RLS `guests_select`) | guest | `useGuestState()` | M1 |
| `menu:drinks` | `drinks` (INSERT/UPDATE/DELETE) per `event_id` (RLS `drinks_select`: ospite vede solo `visibile=true`) | guest, cassa | `useDrinks(scope)` | M2 |
| `session:state` | `tap_sessions` (INSERT/UPDATE `stato`,`ends_at`) per `event_id` | guest, regia | `useTapSession(eventId)` | M3 |
| `session:leaderboard` | `taps` (aggregazione per `guest_id`, order tap_count desc) — solo staff (RLS `taps_select`) | regia | `useLeaderboard(sessionId)` **throttled ~2–4 upd/s** | M3 |
| `admin:stats` | derivata: `guests` (presenze/ticket) + `transactions` (gettoni venduti/importo) | regia | `useAdminStats(eventId)` | M3 (base) → M5 (riconciliazione) |
| `draw:result` | `draws` (INSERT) per `event_id` | regia (+ guest opzionale) | `useDraws(eventId)` | M4 |

**Nota throttle/coalescing:** `session:leaderboard` accumula eventi e ri-renderizza al massimo a un rate fisso (definito in M3) per restare fluido con molti tapper. La UI legge `taps.tap_count` (e `ticket_assegnati` post-close), **mai** ricalcola.

### 0.5 Routing & gating per fase/ruolo
- Route App Router: `/onboarding`, `/guest`, `/cassa`, `/regia`.
- **Gating ruolo (client, decorativo + difeso server):** `readRole()` da `app_metadata.role`. `/cassa` richiede `is_staff` (cassa/regia/admin); `/regia` richiede `regia`/`admin`; `/guest` e `/onboarding` anonimi. Il client nasconde/disabilita; il server resta l'unica autorità (le RPC sollevano comunque).
- **Gating fase:** ogni vista deriva i controlli abilitati da `events.fase` (via `useEventPhase`). La fase è **sempre** letta dalla riga, mai da stato ottimistico non riconciliato. Tabella autoritativa fase→azioni:

| Fase | guest | cassa | regia |
|---|---|---|---|
| SETUP | attesa ("evento non ancora aperto") | controlli OFF | setup menù/parametri, CTA "Apri evento" |
| APERTA | totem+wallet+menù; arena se sessione active | ricarica + consumo ON | fasi, lancio/chiusura sessione, leaderboard |
| LAST_CALL | bar OFF; **CTA Conversione** in evidenza; menù read-only | ricarica/consumo OFF ("Bar chiuso · solo conversione"); può avviare conversione per ospite | CTA "Vai a ESTRAZIONE" |
| ESTRAZIONE | attesa reveal | OFF | pannello run_draw + reveal |
| CHIUSA | riepilogo read-only | OFF | riepilogo read-only, esito draw consultabile |

### 0.6 PWA mobile-first
- `manifest.json` (nome da `config.APP_NAME`, icone, `display: standalone`, `theme_color` da token), service worker registrato. Installabile; **no prompt d'install** per l'ospite (esperienza "apri link e gioca").
- Layout mobile-first: viewport-locked, safe-area insets, tap target ≥44px, no zoom involontario, orientamento portrait. Cassa/regia usabili anche su tablet (layout fluido a colonne da `md:`).
- Service worker: cache shell statica; **mai** cache di dati di gioco (saldi/ticket sempre live). In M5 il SW supporta la coda offline cassa.

### 0.7 Token tema in `:root` + nome app in config (vincolo 5, branding §3/§4/§7)
- Tutti i colori in `:root` (token `--eden-violet`, `--eden-indigo`, `--ember`, `--gold`, `--night-*`, `--ink-*`, `--totem-grad`, semantici `--success`/`--danger`). Nessun hex hardcoded nei componenti.
- Tipografia da branding §4 (display condensato; accenti spaziati; UI geometrica) via variabili `--font-display`/`--font-accent`/`--font-ui`.
- `config.APP_NAME` centralizza il nome ("EDEN · TOTEM" placeholder).
- **Branding = strato sopra la logica:** sostituibile senza toccare dati/RPC/stato.

### 0.8 Componente Totem — isolato e sostituibile (vincolo 4, branding §5/§7)
- **Interfaccia stabile:** `<Totem level={0..6} pulse?={boolean} burst?={signal} igniteOn?={dep} variant="african-demo" />`.
- Riceve **solo** il livello (da `guests.livello_totem`, già calcolato dal server con `totem_level()`). **Zero logica di gioco/ticket** nel componente.
- Demo = **modello totem africano placeholder** (palo intagliato / maschere impilate), 7 stati visivi 0–6 (mappa branding §5). L'albero della vita Eden resta il marchio/logo, non l'asset totem.
- Sostituibile (2D/SVG ora, 3D in futuro) cambiando solo l'implementazione dietro l'interfaccia.
- **Motion signatures (branding §7):** `ignite` (consumo), `tap-burst` (tap), `count-up` (numeri), `reveal` (vincitore). Easing `cubic-bezier(0.16,1,0.3,1)`, mai `linear`. Rispetta `prefers-reduced-motion`.

---

## M1 — Fondamenta: shell PWA, onboarding/T&C, ricarica cassa, guest:state

**Obiettivo FE:** scaffold PWA con le 4 route + token + config; onboarding ospite (anonymous sign-in → T&C → `register_guest`); ricarica cassa (`topup` idempotente, gated APERTA); push `guest:state` del saldo. Nessun ricalcolo client.

### Route → schermate
| Route | Schermate M1 | Note gating |
|---|---|---|
| `/onboarding` | Anonymous sign-in (silenzioso) → **schermata Nome + T&C** (consenso obbligatorio) → conferma → `register_guest` → **totem livello 0 + PIN/QR** | nessun ruolo; idempotente al re-ingresso |
| `/guest` | Home placeholder: Totem L0, wallet (Normali/Premium, ticket totali), QR/PIN | legge `useGuestState` |
| `/cassa` | Selezione/ricerca ospite → form **Ricarica** (tipo normale/premium + quantità + importo €) → esito | solo staff |
| `/regia` | Placeholder dashboard (cablata da M3) | solo regia |

### Stato client (M1)
- `useGuestState()` → cache della **propria** riga `guests` (saldo_normale, saldo_premium, ticket_totali, livello_totem, pin) via SELECT + Realtime UPDATE filtrato `auth_uid`.
- `useEventPhase(eventId)` → fase corrente (introdotto qui, usato dovunque dopo).
- Cassa: stato form (guest selezionato, tipo, qta, importo) + `idem` UUID per la chiamata `topup`.

### RPC usate
`register_guest(event, nome)` (onboarding, idempotente, `consenso_tos_at = now()`), `topup(guest, tipo, qta, importo, idem)` (solo APERTA, idempotente su `idem`).

### Realtime
`guest:state` (saldo si aggiorna sul telefono ospite dopo ricarica, **<2s**, senza refresh), `event:phase`.

### Totem
Render livello 0–6 dalla riga `guests.livello_totem`; in M1 si vede L0/L1 (post-prime ricariche non cambiano livello — il livello cresce coi **consumi**, vedi M2). Interfaccia già stabile.

### Branding/PWA
Token in `:root`, `APP_NAME` in config, manifest+SW installabile, mobile-first. Onboarding usa font accento (spaziato) per il rituale, display per il numero PIN.

### Checklist schermate (§10) — M1
- [ ] Ospite · onboarding + T&C (consenso obbligatorio, blocca `register_guest` senza consenso)
- [ ] Ospite · home totem (livello + ticket + **saldi Normali/Premium**) — versione base
- [ ] Ospite · "mostra alla cassa" (QR/PIN)
- [ ] Cassa · scelta azione (scaffold)
- [ ] Cassa · ricarica (**tipo + quantità + importo**) + feedback transazione
- [ ] Regia · placeholder (struttura)

---

## M2 — Bar loop: consume, menù visibile/attivo, crescita totem, guest:state live

**Obiettivo FE:** cassa risolve ospite (scan QR + fallback PIN), mostra listino normali/premium (solo `attivo=true`), conferma `consume`; regia gestisce menù (`upsert/visibility/active/delete`); guest vede totem salire e wallet/ticket aggiornarsi live (<2s).

### Route → schermate
| Route | Schermate M2 |
|---|---|
| `/guest` | Home completa: **Totem (eroe)** + wallet (2 contatori) + ticket totali + **menù consultabile** (solo `visibile=true`) |
| `/cassa` | **Consuma**: scan QR (camera) + fallback PIN → ospite risolto (nome, saldi) → **listino normali/premium** (solo `attivo=true`) → conferma → esito (ticket assegnati, nuovo saldo) |
| `/regia` | **Gestione menù**: lista voci con toggle separati **visibile** / **attivo**; form CRUD voce (nome, tipo, descrizione, categoria, ordine) |

### Stato client (M2)
- `useDrinks(scope)` con due filtri: **ospite** → `visibile=true`; **cassa** → `attivo=true`; **regia** → tutto. Aggiornato via `menu:drinks` Realtime / re-fetch.
- Cassa consumo: ospite risolto (da SELECT staff su `guests`), drink selezionato, `idem` UUID per `consume`.
- Parametri ticket (4/8) **letti da `events`**, mai hardcoded — usati solo come etichette informative.

### RPC usate
`consume(guest, drink, idem)` (APERTA, scala saldo del **solo tipo** del drink, +ticket_consumo, consumazioni_count++, livello_totem ricalcolato server, idempotente). Regia: `upsert_drink`, `set_drink_visibility`, `set_drink_active`, `delete_drink` (solo regia).

### Realtime
`guest:state` (totem + saldo + ticket salgono dopo consumo cassa, **<2s**), `menu:drinks` (cambi visibile/attivo propagati a guest e cassa), `event:phase`.

### Totem (motion `ignite`)
Al cambio di `livello_totem` (push), il componente esegue **ignite** (ramo/segmento che si accende). Numeri ticket/saldo via **count-up**. Il componente riceve solo `level`; l'animazione di transizione è interna.

### Checklist schermate (§10) — M2
- [ ] Ospite · home totem (livello cresce coi consumi) + wallet + ticket
- [ ] Ospite · menù consultabile (solo `visibile=true`, diviso/ordinato)
- [ ] Cassa · consuma: scan/cerca → **listino normali/premium** (`attivo=true`) → conferma
- [ ] Cassa · feedback transazione (esito, ticket, nuovo saldo del tipo)
- [ ] Regia · gestione menù (CRUD + toggle visibile/attivo)

---

## M3 — Sessioni tap: arena ospite, classifica regia, anti-cheat server-authoritative

**Obiettivo FE:** regia lancia/chiude sessioni (gated APERTA); ospite tappa in arena con countdown e burst; classifica live throttled in regia; ticket convertiti **solo a close_session**. Il client invia tap, **non conta ticket**.

### Route → schermate
| Route | Schermate M3 |
|---|---|
| `/guest` | **Arena tap**: si apre via `session:state` quando parte una sessione; countdown sincronizzato su `ends_at`; area-tap grande con feedback locale immediato (burst); stato "attesa risultati" allo scadere/chiusura |
| `/regia` | **Dashboard live** + **controllo fasi** (SETUP→APERTA→…) + **lancio/chiusura sessione** (lancio disabilitato se esiste sessione `active`; chiusura solo se attiva) + **classifica tap LIVE** (throttled) con `ticket_assegnati` post-close |

### Stato client (M3)
- `useTapSession(eventId)` → `tap_sessions` corrente (stato, ends_at, durata_s). **Countdown locale** derivato da `ends_at` (puramente visivo).
- **Contatore tap ottimistico locale** (visivo): incrementa sul tocco; **batch** ogni ~1s → `register_taps(session, count, elapsed_ms)` con `elapsed_ms` REALE. Il server clampa (rate + cap); il client **non** mostra ticket finché non arrivano dal server.
- `useLeaderboard(sessionId)` (regia) → aggregato `taps` throttled.
- `useAdminStats(eventId)` (base): presenze, gettoni venduti, ticket totali.

### RPC usate
`set_phase(event, phase)` (solo regia), `start_session(event, durata?)` (regia, APERTA, una sola active), `register_taps(session, count, elapsed_ms)` (ospite, anti-cheat clamp/cap server), `close_session(session)` (regia, tap→ticket, idempotente).

### Realtime
`session:state` (apertura/chiusura arena), `session:leaderboard` (regia, **throttled ~2–4/s**, coalescing), `event:phase`, `guest:state` (accredito `ticket_tap` post-close).

### Totem (motion `tap-burst`)
Durante la sessione: **tap-burst** (scintille ambra + punch di scala) ad ogni tocco, aura che pulsa col ritmo; haptic sul telefono. **Importante (documentato):** i ticket da tap **non** alterano `livello_totem` (che dipende da `consumazioni_count`). Post-close, accredito `ticket_tap` via count-up; arena torna idle con riepilogo ticket di sessione.

### Resilienza Realtime
Su drop/reconnect: l'ospite **risincronizza** stato sessione e countdown da `tap_sessions` (no doppi accrediti); tap inviati dopo `ends_at`/close vengono rifiutati lato server e gestiti senza errore bloccante; race close-mentre-tappano → la chiusura prevale.

### Checklist schermate (§10) — M3
- [ ] Ospite · arena tap (countdown + contatore + burst)
- [ ] Regia · controllo fasi (set_phase)
- [ ] Regia · lancio/stop sessione (gating: una sola active)
- [ ] Regia · leaderboard live (throttled) + ticket_assegnati post-close
- [ ] Regia · dashboard stats (base)

---

## M4 — Finale: LAST_CALL, convert_credit, ESTRAZIONE/run_draw, reveal, CHIUSA

**Obiettivo FE:** regia pilota LAST_CALL→ESTRAZIONE→CHIUSA; conversione irreversibile a doppio step (una sola volta per ospite); estrazione provably-fair con reveal animato; CHIUSA read-only. Reveal legge solo `draws.winners`.

### Route → schermate
| Route | Schermate M4 |
|---|---|
| `/guest` | **LAST_CALL**: bar OFF, CTA "Converti le consumazioni rimaste" in evidenza → **modale conferma IRREVERSIBILE** (mostra saldi residui + ticket stimati *informativi*, doppio step) → `convert_credit`. **ESTRAZIONE**: attesa reveal. **CHIUSA**: riepilogo read-only (ticket totali, esito) |
| `/cassa` | LAST_CALL: ricarica/consumo OFF ("Bar chiuso · solo conversione"); può **avviare conversione per un ospite** (stesso doppio step) se l'ospite non riesce; mostra "Già convertito" se esiste transaction `conversione` |
| `/regia` | CTA fasi finali (Vai a LAST_CALL / ESTRAZIONE / Chiudi serata, ognuna con conferma); **pannello estrazione** (n_winners, seed opzionale) → `run_draw` → **reveal vincitori**; pannello audit (seed + pool_snapshot in chiaro) |

### Stato client (M4)
- Fase corrente da `useEventPhase` (verità dalla riga `events.fase`, non ottimistica).
- Conversione: `idem` UUID, modale a doppio step, controlli bloccati durante la chiamata (anti doppio-click). Esito letto da `guests` via Realtime (saldi azzerati, `ticket_conversione` aggiornato) — **mai calcolato come fonte**.
- Stato "già convertito" derivato da `transactions` (esiste riga `tipo='conversione'` per guest).
- `useDraws(eventId)` → `draws` (insert) per reveal e audit.

### RPC usate
`set_phase` (LAST_CALL/ESTRAZIONE/CHIUSA), `convert_credit(guest, idem)` (LAST_CALL, una volta, ospite o staff), `run_draw(event, n_winners, seed?)` (ESTRAZIONE, regia).

### Realtime
`event:phase` (propaga LAST_CALL→… a tutti i ruoli <2s; bar OFF su guest/cassa), `guest:state` (saldi/ticket post-conversione), `draw:result` (insert `draws` → reveal regia, opzionale guest).

### Totem (motion `reveal`)
**Reveal** = pioggia di scintille/embers oro alla proclamazione, sequenza per multi-vincitore. Il reveal **ordina/mostra solo** i `winners` forniti da `run_draw` (`pos, nome, tickets`); **nessuna** logica di sorteggio/pesatura sul client; riproducibile riaprendo la pagina (stato da `draws`). Componente reveal **isolato** (token `--gold`/`--ember`, nessun hex hardcoded).

### CHIUSA
Tutte le viste read-only; le RPC mutanti restano respinte server-side (verificato). Vincitori + seed consultabili per trasparenza.

### Checklist schermate (§10) — M4
- [ ] Ospite · conversione finale (modale irreversibile, doppio step)
- [ ] Ospite · schermata estrazione/vincitore (reveal / attesa)
- [ ] Ospite/Cassa · stato "Già convertito"
- [ ] Cassa · gating LAST_CALL ("Bar chiuso · solo conversione") + avvio conversione per ospite
- [ ] Regia · controllo fasi finali (con conferma)
- [ ] Regia · pannello estrazione (n. premi → estrai → reveal) + audit seed/pool
- [ ] Tutti · riepilogo CHIUSA read-only

---

## M5 — Hardening: idempotenza E2E, coda offline cassa, riconciliazione, dashboard regia

**Obiettivo FE:** idempotenza end-to-end (idem UUID client-side persistito) su `topup`/`consume`/`convert_credit`; coda offline cassa con retry/backoff; pannello riconciliazione regia (read-only dal ledger); dashboard menù/prezzi completa (5 RPC); resilienza realtime; QA device reali; deploy.

### Route → schermate
| Route | Schermate M5 |
|---|---|
| `/cassa` | **Stato coda offline** sulle azioni ricarica/consumo (pending / in-volo / confermato / errore); conferma sempre server-authoritative (saldo da RPC o Realtime) |
| `/regia` | **Pannello riconciliazione**: incassato per `tipo_consumazione` e per `operatore` (somma `transactions(ricarica).importo_euro`), gettoni venduti, campo "incassato dichiarato" + differenza, **export CSV**; **dashboard menù/prezzi** completa (CRUD + toggle visibile/attivo + editor parametri evento via `update_event_settings`) |
| tutte | resync su riconnessione realtime (saldi/fase/menù dalla riga = source of truth) |

### Stato client (M5)
- **Outbox persistente** (IndexedDB/localStorage): `{op, payload, idem, stato, attempt, ts}`, FIFO, retry/backoff. `idem` stabile finché la RPC non conferma → replay sicuro (le RPC ritornano la transaction esistente su idem già visto). Errori non-retriabili (saldo insufficiente, fase) escono dalla coda con messaggio. Mapping stato coda → stato UI; **nessun ricalcolo** client.
- Riconciliazione: aggregazione **read-only** via SELECT staff su `transactions` (RLS `tx_select`); l'incassato dichiarato è solo input UI per il delta visivo.
- Dashboard parametri: form con validazioni UI (tipo ∈ normale/premium, numeri >0) coerenti coi check schema.

### RPC usate
`topup`, `consume`, `convert_credit` (idempotenza E2E), tutte e 5 le RPC gestione: `update_event_settings`, `upsert_drink`, `set_drink_visibility`, `set_drink_active`, `delete_drink`.

### Realtime
Re-subscribe automatico + **resync via SELECT** dopo drop di tutti i canali (`event:phase`, `guest:state`, `session:state`, `admin:stats`, `menu:drinks`); coerenza dopo ciclo offline/online (nessun saldo/ticket stale). `menu:drinks` propaga cambi della dashboard a ospite (`visibile`) e cassa (`attivo`); cambi `events` (prezzi/ticket) senza ricalcolo client.

### PWA / device
Service worker supporta coda offline cassa; QA su iOS Safari + Android Chrome (onboarding, cassa offline mid-operazione, arena tap, conversione, reveal); nessun doppio addebito su rete instabile.

### Checklist schermate (§10) — M5
- [ ] Cassa · indicatore stato coda offline su ricarica/consumo
- [ ] Regia · pannello riconciliazione (per tipo + operatore, delta dichiarato, export CSV)
- [ ] Regia · dashboard menù & prezzi completa (5 RPC, propagazione realtime)
- [ ] Tutte · resync coerente post-riconnessione

---

## Appendice A — Mappa completa Route → Schermate (consolidata §10)

**Ospite (`/onboarding`, `/guest`):** onboarding+T&C · home totem (livello + ticket + saldi Normali/Premium) · mostra-alla-cassa (QR/PIN) · arena tap (countdown + contatore + burst) · conversione finale (modale irreversibile doppio step) · estrazione/vincitore (reveal) · riepilogo CHIUSA.

**Cassa (`/cassa`):** scelta azione · ricarica (tipo + quantità + importo) · consuma (scan/cerca → listino normali/premium `attivo=true` → conferma) · feedback transazione · gating LAST_CALL + avvio conversione per ospite · stato coda offline.

**Regia (`/regia`):** dashboard stats live · controllo fasi · lancio/stop sessione + leaderboard live · gestione menù & prezzi (toggle visibile/attivo, CRUD, editor parametri) · pannello estrazione (n. premi → estrai → reveal) + audit seed/pool · log/riconciliazione cassa (+ export CSV).

## Appendice B — Invarianti FE non negoziabili
1. Nessun ricalcolo di saldi/ticket/livello/winner sul client — tutto da riga server o Realtime.
2. Ogni scrittura via le 14 RPC; nessun INSERT/UPDATE/DELETE diretto.
3. `idem` UUID client-side su `topup`/`consume`/`convert_credit`; retry riusa lo stesso idem.
4. Fase letta da `events.fase` (non ottimistica); gating UI decorativo + server autoritativo.
5. Totem componente isolato/sostituibile, riceve solo `level` 0–6; motion ignite/tap-burst/count-up/reveal; rispetta `prefers-reduced-motion`.
6. Colori in `:root`, nome app in `config`; branding sostituibile senza toccare logica/dati.
7. Realtime con teardown su unmount, RLS-aware, resync-on-reconnect, fallback polling.
