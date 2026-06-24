# Totem Night — Piano Integrazioni

> Output di **@integration-specialist** (team hull). Fonte di verità: `docs/totem-night-spec-pack.md` + `docs/totem-night_db_schema.sql`. Vedi [`PLAN.md`](../../PLAN.md).

---

# Totem Night — Piano integrazioni end-to-end (@integration-specialist)

> Fonte di verità: `totem-night_db_schema.sql` (autoritativo), spec-pack §8/§9, flussi §1/§4. Regola d'oro: il front-end non scrive mai direttamente; ogni mutazione passa dalle 14 RPC `SECURITY DEFINER`. Nessuna integrazione qui sotto deve aggirare RLS o le RPC.

## A. Supabase Auth — Anonymous sign-in (ospite) + claim staff `app_metadata.role`

**Modello (schema §0 + `app_role()`/`is_staff()`):**
- **Ospite**: Supabase *Anonymous sign-in* → `auth.uid()` presente → `register_guest(event, nome)` crea 1 riga `guests(event_id, auth_uid)`. Nessun PII oltre `nome`. La RLS `guests_select` lega l'ospite a `auth_uid = auth.uid()`.
- **Staff**: account reali con claim **`app_metadata.role IN ('cassa','regia','admin')`**. `app_role()` legge il claim da `request.jwt.claims -> app_metadata ->> role`, default `'guest'`. `'admin'` è super-staff (passa sempre in `is_staff`).

**Punti d'integrazione critici:**
1. **Anonymous sign-in va abilitato nelle impostazioni Auth Supabase** (toggle progetto). Se off, `register_guest`/`register_taps` falliscono con `autenticazione richiesta`. → setup esterno, va fatto prima di M1-S3.
2. **Il claim `role` deve stare in `app_metadata`** (lato server, non modificabile dall'utente), NON in `user_metadata`. Si imposta via **Admin API** (`auth.admin.updateUserById(uid, { app_metadata: { role: 'cassa' } })`) usando la `service_role` key, oppure dal dashboard. Procedura da scriptare (idempotente) + runbook.
3. **Propagazione claim nel JWT**: il claim entra nel JWT solo a **nuovo login / refresh token**. Dopo aver settato il ruolo, lo staff deve ri-loggarsi. Documentare nel runbook (gotcha tipico: "ho settato regia ma `set_phase` dice solo regia" = token vecchio).
4. **Account anonimi e retention**: Supabase può pulire utenti anonimi inattivi. Per Totem Night la sessione vive una serata → accettabile, ma documentare che un ospite che cancella i cookie perde l'accesso alla propria riga (PIN/QR resta il canale di recupero via cassa).
5. **`service_role` key mai nel client/bundle**: usata solo lato server (Admin API per i claim, seed, deploy). `anon` key nel client.

**OQ:** serve un flusso self-service per creare account staff o li crea l'admin a mano? Per la prima serata → creazione manuale + script claim. Annotato.

## B. Supabase Realtime — sottoscrizioni per ruolo, throttling, sicurezza RLS sui canali

Mappatura canali spec §8 → tabelle/righe (i "canali" sono Postgres Changes filtrati da RLS, non logica di gioco):

| Canale logico | Sorgente Postgres Changes | Filtro/visibilità | Ruolo |
|---|---|---|---|
| `event:phase` | `events` (UPDATE su `fase`) | `events_select` = tutti gli autenticati | tutti |
| `guest:state` | `guests` (UPDATE riga ospite) | `guests_select`: ospite solo la propria riga, staff tutte | ospite (propria), staff |
| `session:state` | `tap_sessions` (INSERT/UPDATE `stato`,`ends_at`) | `sessions_select` = tutti | tutti |
| `session:leaderboard` | `taps` (INSERT/UPDATE `tap_count`) | `taps_select`: staff tutti, ospite solo i propri | **regia** (aggregato), ospite (proprio) |
| `admin:stats` | aggregazione `transactions`/`guests` | `tx_select`/`guests_select` solo staff | regia |
| menù live | `drinks` (UPDATE `visibile`/`attivo`) | `drinks_select`: ospite solo `visibile=true`, staff tutto | ospite, cassa |
| `draws` reveal | `draws` (INSERT) | `draws_select` = tutti | regia (reveal), guest |

**Sicurezza RLS sui canali (vincolo non negoziabile):**
- Supabase Realtime con **RLS abilitata su Postgres Changes**: ogni client riceve solo le righe che la sua SELECT policy autorizza. Va **verificato esplicitamente** che `guest:state` non perda righe altrui (test "no leak") e che `session:leaderboard` completo arrivi solo a staff. La policy esiste già; l'integrazione deve abilitare Realtime sulla pubblicazione per le tabelle interessate (`alter publication supabase_realtime add table ...`) — **non presente nello schema**, è un passo di setup Realtime da aggiungere come migrazione additiva.
- L'ospite **non deve** sottoscrivere `taps` di tutta la sessione (lo farebbe filtrato dalla RLS → riceve solo i propri, ma per la leaderboard live conviene che la classifica completa sia montata SOLO in regia per non sprecare banda).

**Throttling leaderboard:**
- `register_taps` è chiamata in batch (~1/s per ospite) → con N ospiti che tappano, `taps` genera molti change. La regia deve **coalescere/throttlare** lato client a ~2–4 update/s (debounce + merge per `guest_id`), come da design M3-S1. Il throttle è **client-side**: nessun ricalcolo, solo rate di re-render. Sorgente classifica = `taps` ordinata `tap_count desc`; i ticket appaiono solo dopo `close_session` (`ticket_assegnati`).

**Resilienza (M5-S2):** alla riconnessione il client **ri-fetcha** lo stato corrente (saldi/fase/menù/sessione) come source-of-truth invece di fidarsi degli eventi persi; re-subscribe automatico; teardown su unmount per evitare leak di canali.

## C. Pagamento ricarica — POS/contanti (default) vs Stripe (OPEN QUESTION)

**Stato schema:** `topup(p_guest, p_tipo, p_qta, p_importo, p_idem)` registra `transactions(tipo='ricarica', importo_euro, operatore)` e incrementa il saldo del tipo. **Lo schema NON modella né PaymentIntent né webhook Stripe**: `importo_euro` è un campo dichiarativo per la riconciliazione. Per i flussi (§4) il default è **POS/contanti incassati a mano dalla cassa**, registrati con `topup`.

**Percorso default (POS/contanti) — già supportato, nessun setup esterno:**
- La cassa incassa fisicamente (POS terminale o contanti), poi chiama `topup` con `importo_euro` = euro reali incassati.
- **Idempotenza**: `p_idem` = UUID generato dal client e **riusato sul retry** (PK su `transactions.id` → la seconda chiamata ritorna la stessa riga, niente doppio accredito). Persistere l'idem nella coda offline (M5) finché la RPC conferma.
- **Riconciliazione (§11)**: vista sola-lettura che somma `transactions(tipo='ricarica').importo_euro` per `tipo_consumazione` e per `operatore`, confrontata con l'incassato dichiarato. Append-only → quadratura riproducibile. Sola SELECT via `tx_select` (staff), nessuna nuova RPC di scrittura.

**Percorso Stripe (cashless) — MARCATO OPEN QUESTION:**
- **Non nello scope dello schema attuale.** Richiederebbe: account Stripe + KYC, chiavi (test/live), un endpoint server (Edge Function/route server) per creare PaymentIntent, un **webhook** `payment_intent.succeeded` che chiama `topup` con `service_role` (il client NON deve accreditare il saldo prima della conferma di pagamento). L'`importo_euro` verrebbe dal PaymentIntent; l'`p_idem` derivato dall'id PaymentIntent per idempotenza naturale.
- **Lead-time esterno lungo**: onboarding Stripe + verifica account + (se incasso reale) requisiti fiscali. → da **decidere prima di committare l'architettura**; per la prima serata il default POS/contanti elimina la dipendenza.
- **OQ aperte:** (a) serata cashless o cassa fisica? (b) se Stripe, chi è il merchant of record / aspetti fiscali §11? (c) gestione rimborsi (T&C dicono "no rimborso" → semplifica, ma i chargeback Stripe restano). **Decisione richiesta da product/legale prima del build.**

## D. Storage asset totem — Supabase Storage, modello africano demo sostituibile

- **Vincolo 4**: il Totem è componente **isolato e sostituibile** dietro interfaccia stabile (prop `livello 0–6`); demo = **modello totem africano placeholder**, l'asset definitivo (albero della vita Eden) arriverà dopo (branding §3).
- **Integrazione**: bucket **Supabase Storage pubblico** `totem-assets` con gli asset per livello (0–6) + eventuale modello 3D/sprite. Il componente legge gli URL da **config branding centralizzata** (token `:root` + nome app), NON hardcoded. Cambiare l'asset definitivo = sostituire i file nel bucket / aggiornare la config, **senza toccare logica wallet/totem**.
- `drinks.immagine_url` esiste già nello schema → anche le immagini del menù possono vivere nello stesso bucket (o un bucket `drinks`). Definire policy bucket: lettura pubblica (asset non sensibili), upload solo staff/admin via service_role o policy Storage.
- **Lead-time**: l'asset Eden definitivo è una dipendenza ESTERNA di consegna (branding §8 "asset del totem demo … l'asset definitivo verrà fornito"). Il placeholder sblocca tutto lo sviluppo; flag lead-time sul rendering finale.

## E. Push / Web Push PWA — OPZIONALE

- **Non nei vincoli, non nello schema.** Lo stato live arriva via **Realtime mentre la PWA è aperta** (l'ospite tiene il telefono in mano durante la serata) → web push largamente ridondante per il loop core.
- Eventuale uso: notificare "sessione tap in arrivo" o "estrazione" a chi ha l'app in background. Richiede: VAPID keys, service worker con `push`/`notificationclick`, persistenza subscription (nuova tabella → **modifica schema, va approvata da spec-guardian**), permesso utente (su iOS Safari solo da PWA installata "Aggiungi a Home", iOS 16.4+).
- **Lead-time/attriti**: permessi notifiche su iOS sono fragili; non bloccare la milestone core. **Marcato opzionale/post-MVP.** Default: NESSUN push, Realtime in-app è sufficiente.

## Sicurezza trasversale (per tutte le integrazioni)
- Secret hygiene: `anon` key nel client; `service_role`, eventuali chiavi Stripe e VAPID **solo server / secrets CI**, mai committate (cf. memoria "rotate-shared-credentials" — credenziali condivise in chat vanno ruotate).
- Realtime e Storage non devono mai esporre dati oltre quanto già concesso da RLS/policy.
- Ogni accredito di saldo/ticket passa SOLO da RPC; nessuna integrazione (incluso un eventuale webhook Stripe) scrive direttamente sui saldi senza passare da `topup`.

## Riepilogo lead-time esterni (setup lungo)
1. **Abilitazione Anonymous sign-in** (Supabase) — breve ma bloccante, fare in M1.
2. **Claim staff via Admin API** + ri-login per propagazione JWT — procedurale, runbook.
3. **`alter publication supabase_realtime`** per le tabelle dei canali — migrazione additiva da aggiungere.
4. **Stripe (se scelto)** — account/KYC/fiscale = lead-time lungo, decisione product/legale prima del build → **OQ**.
5. **Asset totem Eden definitivo** — consegna esterna (terza parte branding); placeholder sblocca lo sviluppo.
6. **Web push VAPID + iOS PWA install** — opzionale, post-MVP.

## Integration tasks

| ID | Titolo | Owner | Dipende da | Lead-time |
|---|---|---|---|---|
| T-INT-01 | Abilitare Anonymous sign-in su Supabase (dev/staging/prod) + smoke auth.uid ospite | @integration-specialist | T-M1-01 | esterno-breve: toggle impostazioni Auth Supabase, bloccante per register_guest/register_taps |
| T-INT-02 | Procedura+script idempotente per claim staff app_metadata.role (cassa/regia/admin) via Admin API/service_role; runbook ri-login per propagazione JWT | @integration-specialist | T-M1-01, T-M1-05 | procedurale: gotcha claim attivo solo a nuovo refresh token, documentare |
| T-INT-03 | Migrazione additiva: alter publication supabase_realtime add table (events, guests, tap_sessions, taps, drinks, draws) — abilita Postgres Changes per i canali | @integration-specialist | T-M1-03 | interno: passo non presente nello schema, richiede approvazione spec-guardian come migrazione additiva idempotente |
| T-INT-04 | Verifica RLS-safety dei canali Realtime: guest:state no-leak (solo propria riga), leaderboard completo solo staff, menù visibile=true per ospite | @integration-specialist | T-INT-03, T-M1-09 | nessuno |
| T-INT-05 | Strategia throttle/coalescing client per session:leaderboard (debounce ~2-4 update/s, merge per guest_id) senza ricalcolo client | @integration-specialist | T-INT-03 | nessuno |
| T-INT-06 | Helper Realtime riusabile: subscribe per ruolo + teardown su unmount + ri-fetch source-of-truth alla riconnessione (saldi/fase/menù/sessione) | @integration-specialist | T-INT-03 | nessuno |
| T-INT-07 | Flusso topup POS/contanti: idem UUID client riusato su retry, importo_euro reale, operatore=auth.uid; nessun setup pagamento esterno | @integration-specialist | T-M1-08 | nessuno: percorso default, elimina dipendenza Stripe per la prima serata |
| T-INT-08 | Vista riconciliazione cassa (sola SELECT): somma transactions.ricarica.importo_euro per tipo e operatore vs incassato dichiarato; export CSV; gate staff | @integration-specialist | T-M1-08, T-M5-06 | nessuno |
| T-INT-09 | OPEN QUESTION Stripe cashless: decidere se serata cashless; se sì progettare Edge Function PaymentIntent + webhook payment_intent.succeeded -> topup via service_role (idem da PaymentIntent id), KYC/fiscale, chargeback | @integration-specialist | T-M1-08 | OQ + esterno-lungo: account/KYC Stripe e aspetti fiscali; decisione product/legale PRIMA di committare l'architettura; non nello schema attuale |
| T-INT-10 | Supabase Storage bucket totem-assets (livelli 0-6) + URL in config branding centralizzata; asset africano placeholder sostituibile senza toccare logica | @integration-specialist | T-M1-01, T-M2-08 | esterno-consegna: asset Eden definitivo fornito da terza parte (branding); placeholder sblocca lo sviluppo |
| T-INT-11 | Policy bucket Storage: lettura pubblica asset non sensibili, upload solo staff/admin; opzionale bucket drinks per drinks.immagine_url | @integration-specialist | T-INT-10 | nessuno |
| T-INT-12 | OPZIONALE Web Push PWA: VAPID keys + service worker push + tabella subscription (modifica schema da approvare) + permessi iOS PWA install | @integration-specialist | T-M1-02 | opzionale/post-MVP + esterno: permessi iOS fragili, Realtime in-app rende ridondante per il loop core; non bloccare milestone |
| T-INT-13 | Secret hygiene cross-integrazione: anon key client, service_role/Stripe/VAPID solo server/CI secrets, mai committate; ruotare credenziali condivise in chat | @integration-specialist | T-M1-01 | nessuno |
| T-INT-14 | Smoke test integrazioni post-deploy prod: anon sign-in, claim staff attivo, propagazione Realtime <2s su events.fase/guests, lettura asset Storage, riconciliazione legge ledger | @integration-specialist | T-INT-01, T-INT-02, T-INT-03, T-INT-10, T-M5-14 | nessuno |
