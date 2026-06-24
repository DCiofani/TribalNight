# TOTEM NIGHT — Spec Brief per build in Claude Code

> **Versione 0.1** — brief di partenza per strutturare lo sviluppo. I numeri (prezzi, ticket, durate) sono **default configurabili**: vanno confermati prima del go-live. Tema: aperitivo cenato tribale con totem-gaming + estrazione finale.

---

## 1. Concept in una riga

Ogni ospite ha un **totem digitale** sul proprio telefono che si "alimenta" a ogni consumazione. Consumare e partecipare alle **sessioni di click** a tempo fa accumulare **ticket**; a fine serata si fa un'**estrazione pesata** sui ticket. Obiettivo: spingere il consumo trasformandolo in gioco.

---

## 2. Attori e viste

| Attore | Device | Cosa fa | Cosa vede |
|---|---|---|---|
| **Ospite** | proprio telefono (PWA, no install) | ricarica, paga al bar mostrando il suo codice, tappa il totem nelle sessioni, converte il residuo a fine serata | il suo totem che cresce, il menù cocktail consultabile, consumazioni disponibili divise per tipo (normali / premium), ticket totali, codice/QR di pagamento, arena di tap |
| **Cassa** | telefono/tablet staff | ① **Ricarica**: incassa denaro reale → accredita gettoni; ② **Consuma**: legge il codice ospite → scala gettoni → drink | lista/ricerca ospiti, listino drink, conferma transazione |
| **Regia/Admin** | telefono/laptop | lancia le sessioni di click, gestisce le fasi, fa l'estrazione | dashboard real-time: presenze, gettoni venduti, ticket totali, classifica tap live |

---

## 3. Macchina a fasi della serata

```
SETUP  →  APERTA  →  LAST_CALL (ultimi 5')  →  ESTRAZIONE  →  CHIUSA
```

| Fase | Ricarica | Consumo al bar | Sessioni tap | Conversione residuo | Estrazione |
|---|:--:|:--:|:--:|:--:|:--:|
| SETUP | – | – | – | – | – |
| APERTA | ✅ | ✅ | ✅ (a finestre) | ❌ | ❌ |
| LAST_CALL | ❌ *(disabilitata)* | ❌ *(bar chiuso)* | ❌ | ✅ | ❌ |
| ESTRAZIONE | ❌ | ❌ | ❌ | ❌ | ✅ |
| CHIUSA | ❌ | ❌ | ❌ | ❌ | – |

**Perché le ricariche sono OFF in LAST_CALL:** evita che si comprino gettoni col contante all'ultimo secondo solo per convertirli in ticket → ridurrebbe il tutto a "comprare biglietti della lotteria". Durante la serata invece è consumo + gioco.

---

## 4. Economia: consumazioni e ticket

### Credito = due tipi di consumazione SEPARATI
Il credito NON è in euro e NON è un'unica valuta: esistono **due tipi di consumazione distinti**, ognuno con il proprio saldo. Si comprano con **denaro reale** alla cassa-ricarica.

| Tipo | Prezzo (default) | Esempi drink |
|---|:--:|---|
| **Normale** | €5 cad. | birra, calice, analcolico |
| **Premium** | €8 cad. | cocktail, distillati |

- Un drink **normale** consuma **1 consumazione normale**; un drink **premium** consuma **1 consumazione premium**. **Non sono intercambiabili** (la premium non "vale" 2 normali: è un'altra cosa).
- In interfaccia l'ospite vede **due contatori separati** (Normali / Premium); idem alla cassa per ricarica e consumo.
- **Nessun rimborso**: le consumazioni non spese non si riconvertono in denaro (accettato nei T&C all'ingresso).

### Ticket — le 3 fonti
| Fonte | Regola (default) | Note |
|---|---|---|
| **Consumo** | **normale → +4 ticket**, **premium → +8 ticket** | la premium "vale" di più perché costa di più; fa crescere anche il totem |
| **Tap** | **1 ticket ogni 10 tap validati**, sessione da 30s | conteggio server-authoritative, rate cap anti-autoclicker |
| **Conversione finale** | **normale → +5**, **premium → +10** (leggermente > del consumo) | solo in LAST_CALL, **irreversibile**; converte entrambi i saldi residui |

> La leva chiave resta il rapporto **consumo vs conversione** (default normale 4→5, premium 8→10): la conversione vale un po' di più per spingere a usare il credito invece di lamentarsi, e incoraggia a ricaricare di più durante la serata. Regolabile per tipo.

### Tetto ticket
- **Nessun tetto per persona** (scelta esplicita): chi spende di più ha più probabilità.
- Unico limite tecnico = la **validazione anti-autoclicker** sui tap (non è un tetto ai ticket, è anti-cheat).

---

## 5. Regole anti-abuso e fairness

- **Saldo gettoni e conteggio ticket sono SEMPRE server-authoritative.** Il client non decide mai i numeri.
- **Tap validati lato server**: il client invia i tap, il server scarta quelli oltre un rate umano plausibile (es. > 12 tap/s) e applica un tetto per sessione.
- **1 utente = 1 device/sessione attiva** per la stessa identità.
- **Pagamenti idempotenti**: ogni transazione ha un id univoco lato client → niente doppio addebito su retry/rete instabile.
- **Log transazioni immutabile** (append-only): ogni ricarica/consumo/conversione è tracciato per riconciliazione cassa.
- **Conversione finale con conferma esplicita** (vedi §7.5).

---

## 6. Modello dati (schema di partenza)

```
events
  id, nome, fase ∈ {SETUP,APERTA,LAST_CALL,ESTRAZIONE,CHIUSA},
  prezzo_normale, prezzo_premium,
  ticket_consumo_normale, ticket_consumo_premium,
  ticket_conversione_normale, ticket_conversione_premium,
  tap_ticket_ogni, durata_sessione_s, created_at

guests
  id, event_id, nome, pin, consenso_tos_at,
  saldo_normale, saldo_premium,  -- due saldi distinti, non intercambiabili
  ticket_consumo, ticket_tap, ticket_conversione,  -- separati per fonte/stats
  consumazioni_count,            -- alimenta il livello del totem
  livello_totem, created_at, last_seen

drinks
  id, event_id, nome, tipo ∈ {normale,premium},  -- consuma 1 unità del saldo corrispondente
  descrizione, categoria, immagine_url, ordine,  -- presentazione nel menù
  visibile,                                      -- mostrato nel menù ospite
  attivo                                         -- ordinabile alla cassa

transactions            -- append-only
  id (idempotency key), event_id, guest_id,
  tipo ∈ {ricarica, consumo, conversione},
  tipo_consumazione ∈ {normale,premium},   -- a quale saldo si riferisce
  qta_delta, ticket_delta, operatore (cassa), ts

tap_sessions
  id, event_id, stato ∈ {pending,active,closed},
  start_ts, durata_s, ticket_ogni

taps                    -- aggregato per (sessione, ospite)
  session_id, guest_id, tap_count_validati, ticket_assegnati

draws
  id, event_id, ts, seed,        -- seed salvato = estrazione verificabile
  pool_snapshot (lista guest_id + ticket al momento), vincitori []
```

Ticket totali di un ospite = `ticket_consumo + ticket_tap + ticket_conversione`.

---

## 7. Flussi principali

### 7.1 Onboarding + consenso
QR/link all'ingresso → schermata nome → **accetta T&C** (no rimborso, regole estrazione, privacy) → crea `guest` con `pin` e codice/QR personale. Niente app da installare (PWA).

### 7.2 Ricarica (denaro reale → gettoni)
Cassa seleziona ospite → sceglie **tipo** (normale/premium) e quantità → incassa (POS/Stripe/contanti) → `transaction(ricarica, tipo)` → `saldo_normale` o `saldo_premium += n`. Realtime push al telefono dell'ospite.

### 7.3 Consumo al bar
Ospite mostra **QR/PIN** → cassa sceglie il drink → decrementa il saldo del **tipo corrispondente** (`saldo_normale--` oppure `saldo_premium--`, blocca se a 0) → `ticket_consumo += (normale 4 | premium 8)` → `consumazioni_count++` → ricalcola `livello_totem`. Animazione "tap-to-pay" + push realtime → il totem dell'ospite sale.

### 7.4 Sessione di click (real-time)
Regia preme **"Lancia sessione 30s"** → `tap_session(active)` in broadcast → ogni telefono apre l'**arena di tap** con countdown → ogni tap → invio al server (batch) → server valida e aggrega → **classifica live** in Regia → allo scadere: `ticket_tap += floor(tap_validati/10)`, sessione `closed`, arena si chiude. (Più sessioni durante la serata.)

### 7.5 Conversione finale (LAST_CALL)
Regia apre la fase → ospiti con saldo residuo (normale e/o premium) vedono **"Converti le consumazioni rimaste in ticket"** col dettaglio dei due tipi →
**modale di conferma**: *"Attenzione: la conversione è irreversibile. Le consumazioni convertite non potranno essere riaccreditate né rimborsate."* → conferma → `ticket_conversione += 5×normali + 10×premium`, azzera entrambi i saldi, `transaction(conversione)` per ciascun tipo.

### 7.6 Estrazione pesata (provably fair)
Regia chiude tutto → si genera un **seed** (salvato) → si costruisce il pool pesato sui ticket totali → estrazione casuale (1 o più premi, senza ripetere il vincitore) → **reveal animato**. Seed + snapshot pool salvati in `draws` → l'esito è verificabile se contestato.

---

## 8. Real-time (canali/eventi)

- `event:phase` — cambia fase (tutti).
- `session:state` — sessione tap pending/active/closed (tutti).
- `session:leaderboard` — conteggi tap live (solo Regia, throttled).
- `guest:state` — saldo/ticket/totem del singolo ospite (push privato).
- `admin:stats` — presenze, gettoni venduti, ticket totali (Regia).

---

## 9. Stack consigliato

- **Front**: Next.js (App Router) come **PWA mobile-first**. Route: `/onboarding`, `/guest`, `/cassa`, `/regia`.
- **Backend/DB/Realtime/Auth**: **Supabase** (Postgres + Realtime + **Row Level Security**). L'RLS protegge saldo/ticket: l'ospite legge solo i propri dati, scrive solo i tap; saldo e ticket li muovono solo funzioni server (RPC) / ruolo cassa.
- **Pagamento ricarica**: **Stripe** (se cashless digitale) oppure POS/contanti registrati a mano dalla cassa.
- **Server-authoritative**: usa **Postgres functions / RPC** per ricarica, consumo, conversione e chiusura sessione (transazioni atomiche, idempotenti).

```
/app
  /onboarding   → nome + consenso T&C → crea guest
  /guest        → totem, wallet, QR pagamento, arena tap, conversione
  /cassa        → ricarica | consuma (scan QR/PIN + listino)
  /regia        → dashboard live, fasi, lancio sessioni, estrazione
/lib            → supabase client, regole ticket (config), realtime hooks
/db             → schema.sql, rpc (ricarica/consumo/conversione/draw), policies RLS
```

---

## 10. Schermate minime (checklist UI)

- **Ospite**: onboarding+T&C · home totem (livello + ticket + **saldi normali/premium**) · "mostra alla cassa" (QR/PIN) · arena tap (countdown + contatore + burst) · conversione finale (modale) · schermata estrazione/vincitore.
- **Cassa**: scelta azione · ricarica (**tipo + quantità**) · consuma (scan/cerca → **listino normali/premium** → conferma) · feedback transazione.
- **Regia**: dashboard stats · controllo fasi · lancio/stop sessione + leaderboard live · gestione menù & prezzi (mostra/nascondi voci, modifica numeri) · pannello estrazione (n. premi → estrai → reveal) · log/riconciliazione.

---

## 11. Compliance & legal (da validare con un consulente)

- ⚠️ **Concorso/operazione a premio**: in Italia un'estrazione a premi legata ad acquisto/credito ricade tipicamente nel **DPR 430/2001** — può richiedere **regolamento, cauzione e notifica al Ministero**, salvo esenzioni. Da verificare con commercialista/consulente **prima** dell'evento.
- **T&C + privacy** in onboarding: no rimborso gettoni, regole estrazione, trattamento dati (nome) — GDPR.
- **Niente alcol a minori**: l'app non sostituisce il controllo dell'età alla cassa.
- **Riconciliazione cassa**: i `transaction(ricarica)` devono quadrare con l'incassato reale.

---

## 12. Ordine di build consigliato (milestone per Claude Code)

1. **M1 — Fondamenta**: schema Supabase + RLS + onboarding/consenso + wallet (ricarica) server-authoritative.
2. **M2 — Bar loop**: cassa consuma (QR/PIN + listino tier) → ticket consumo + crescita totem + realtime sul telefono ospite.
3. **M3 — Sessioni tap**: macchina a fasi + lancio sessione 30s + arena tap + leaderboard live + conversione tap→ticket con validazione anti-cheat.
4. **M4 — Finale**: LAST_CALL + conversione residuo (modale irreversibile) + estrazione pesata provably-fair + reveal.
5. **M5 — Hardening**: idempotenza, resilienza offline cassa, rate-limit, riconciliazione, QA su device reali.

---

## 13. Open items da fissare prima del build

- Prezzi consumazione **normale** e **premium** (€) e tagli di ricarica.
- Numeri ticket definitivi per tipo — default: consumo 4 (normale) / 8 (premium), tap 1-ogni-10, conversione 5 (normale) / 10 (premium).
- Numero e durata sessioni di tap nella serata.
- Premi in palio e numero di vincitori.
- Branding/nome dell'app e identità visiva tribale.

> Nota: i valori numerici sono ipotesi di partenza, non vincoli. Sono tutti centralizzati nella tabella `events` così da poterli cambiare senza toccare il codice.
