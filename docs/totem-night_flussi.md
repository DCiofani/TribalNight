# TOTEM NIGHT — Flussi e macchina a fasi

> Diagrammi Mermaid che mappano 1:1 le funzioni RPC dello schema (`totem-night_db_schema.sql`).
> Ogni freccia verso il DB corrisponde a una funzione server-authoritative.

## Mappa flusso → RPC

| Flusso | Chi lo avvia | RPC chiamata |
|---|---|---|
| Onboarding ospite | Ospite | `register_guest(event, nome)` |
| Ricarica credito | Cassa | `topup(guest, tipo, qta, importo, idem)` |
| Consumo al bar | Cassa | `consume(guest, drink, idem)` |
| Cambio fase serata | Regia | `set_phase(event, phase)` |
| Avvio sessione tap | Regia | `start_session(event, durata)` |
| Registra tap | Ospite | `register_taps(session, count, elapsed_ms)` |
| Chiusura sessione | Regia | `close_session(session)` |
| Conversione finale | Ospite / Staff | `convert_credit(guest, idem)` |
| Estrazione | Regia | `run_draw(event, n_winners, seed)` |

---

## 1) Mappa ruoli e sistema

```mermaid
flowchart LR
    subgraph Telefoni
      O["📱 Ospite<br/>(PWA)"]
      C["📱 Cassa<br/>(staff)"]
      R["🖥️ Regia<br/>(admin)"]
    end
    DB[("Supabase<br/>Postgres + RLS<br/>Funzioni RPC")]
    RT{{"Realtime<br/>(push live)"}}

    O -- "register_guest, register_taps, convert_credit" --> DB
    C -- "topup, consume" --> DB
    R -- "set_phase, start_session, close_session, run_draw" --> DB
    DB --> RT
    RT -- "totem, saldi, ticket" --> O
    RT -- "classifica tap, stats" --> R
```

---

## 2) Macchina a fasi della serata

```mermaid
stateDiagram-v2
    [*] --> SETUP
    SETUP --> APERTA: regia apre l'evento
    APERTA --> APERTA: ricariche · consumi · sessioni tap
    APERTA --> LAST_CALL: ultimi 5 minuti
    LAST_CALL --> ESTRAZIONE: chiusura conversioni
    ESTRAZIONE --> CHIUSA: dopo il sorteggio
    CHIUSA --> [*]

    note right of APERTA
        Abilitati: topup, consume,
        start_session / register_taps / close_session
    end note
    note right of LAST_CALL
        Bar chiuso · ricariche OFF
        Solo convert_credit (irreversibile)
    end note
    note right of ESTRAZIONE
        Solo run_draw (pesata sui ticket)
    end note
```

---

## 3) Onboarding ospite

```mermaid
sequenceDiagram
    actor O as Ospite
    participant A as App (PWA)
    participant DB as Supabase

    O->>A: apre link/QR all'ingresso
    A->>DB: anonymous sign-in (auth.uid)
    A->>O: mostra T&C
    O->>A: accetta T&C
    A->>DB: register_guest(event, nome)
    DB-->>A: guest {id, pin, saldi=0, ticket=0}
    A-->>O: totem (livello 0) + PIN/QR
```

---

## 4) Ricarica credito (denaro reale → consumazioni)

```mermaid
sequenceDiagram
    actor O as Ospite
    actor K as Cassa
    participant DB as Supabase

    O->>K: "10€ di normali" (paga reale: POS/contanti)
    K->>DB: topup(guest, 'normale', qta, importo, idem)
    Note over DB: verifica staff + fase=APERTA<br/>idempotenza su idem
    DB-->>K: saldo aggiornato + transaction
    DB-->>O: push realtime: saldo_normale +N
```

---

## 5) Consumo al bar (1 gettone del tipo → ticket + totem)

```mermaid
sequenceDiagram
    actor O as Ospite
    actor K as Cassa
    participant DB as Supabase

    O->>K: mostra QR/PIN, ordina drink
    K->>DB: consume(guest, drink, idem)
    Note over DB: fase=APERTA · saldo del tipo ≥ 1<br/>premium → più ticket
    DB-->>K: -1 saldo · +ticket_consumo · totem++
    DB-->>O: push: totem cresce, ticket salgono
```

---

## 6) Sessione di tap (30s, lanciata dalla regia)

```mermaid
sequenceDiagram
    actor R as Regia
    participant DB as Supabase
    actor O as Ospiti
    R->>DB: start_session(event, 30)
    DB-->>O: push: arena tap attiva (countdown)
    loop ogni ~1s mentre tappa
        O->>DB: register_taps(session, count, elapsed_ms)
        Note over DB: anti-autoclicker:<br/>clamp al rate massimo + tetto sessione
    end
    DB-->>R: push: classifica tap LIVE
    R->>DB: close_session(session)
    Note over DB: tap → ticket (1 ogni N), idempotente
    DB-->>O: push: ticket_tap accreditati
```

---

## 7) Conversione finale (LAST_CALL, irreversibile)

```mermaid
sequenceDiagram
    actor R as Regia
    actor O as Ospite
    participant DB as Supabase

    R->>DB: set_phase(event, 'LAST_CALL')
    DB-->>O: push: "Converti le consumazioni rimaste"
    O->>O: legge alert "irreversibile, non rimborsabile"
    O->>DB: convert_credit(guest, idem)
    Note over DB: fase=LAST_CALL · una sola volta<br/>norm×5 + prem×10 (default)
    DB-->>O: saldi azzerati · ticket_conversione +X
```

---

## 8) Estrazione pesata (provably fair)

```mermaid
sequenceDiagram
    actor R as Regia
    participant DB as Supabase

    R->>DB: set_phase(event, 'ESTRAZIONE')
    R->>DB: run_draw(event, n_winners, seed?)
    Note over DB: seed salvato · pool ordinato per id<br/>sorteggio pesato senza reimmissione
    DB-->>R: draw {seed, pool_snapshot, winners}
    R->>R: reveal vincitore/i
    Note over DB: stesso seed + snapshot = stesso esito<br/>(verificabile a posteriori)
```

---

### Note di lettura
- Le frecce **verso il DB** sono sempre funzioni RPC `SECURITY DEFINER`: i client non scrivono mai direttamente su saldi/ticket.
- I **push realtime** sono cambi di riga propagati da Supabase Realtime; nessuna logica di gioco vive sul client.
- `idem` = chiave di idempotenza generata dal client: rende sicuri i retry su rete instabile.
