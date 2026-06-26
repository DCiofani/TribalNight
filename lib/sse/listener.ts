import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// lib/sse/listener.ts — Fase 4 (strangler, flagged): listener PG LISTEN/NOTIFY.
//
// Singleton che apre UNA connessione Postgres DIRETTA dedicata e fa
//   LISTEN guest_state;
//   LISTEN event_phase;
// mantenendo un registry di subscriber in-process. Su ogni notifica fa il
// fan-out ai callback registrati. Espone:
//   subscribeGuest(guestId, cb) -> unsubscribe
//   subscribePhase(cb)          -> unsubscribe
// usati dalle route SSE (/api/guest/[id]/stream e simili) per pushare al client.
//
// PERCHÉ UNA CONNESSIONE DIRETTA DEDICATA (non withAuth/pgbouncer):
//   LISTEN è una sessione persistente legata alla connessione fisica. Con
//   pgbouncer in transaction-mode la connessione viene multiplexata tra client
//   ad ogni transazione → un LISTEN registrato non sopravvive e le NOTIFY non
//   arrivano. Serve quindi una connessione PG DIRETTA (env DATABASE_URL_DIRECT,
//   fallback DATABASE_URL) tenuta aperta SOLO per ascoltare. Le RPC/SELECT
//   restano su pgbouncer via lib/db.ts::withAuth.
//
// PRIVACY: il payload NOTIFY porta SOLO un id (guest_id) o id+fase (event_phase),
// MAI pin/saldi. Il client, ricevuto l'evento, rilegge la riga autoritativa via
// GET /api/guest/[id] (RLS-scoped). Questo modulo NON legge dati ospite: smista
// solo gli identificatori. server-only: non deve finire nel bundle client.
//
// RESILIENZA: se la connessione cade (errore/`end`), si riconnette con backoff
// esponenziale (cap) e ri-esegue i LISTEN. I subscriber restano registrati
// attraverso la riconnessione: alla riconnessione ricominciano a ricevere senza
// doversi ri-registrare. (Una NOTIFY emessa mentre eravamo disconnessi è persa:
// è accettabile perché il client fa comunque un refetch all'apertura dello
// stream e i refetch sono autoritativi.)
//
// Memoizzato su globalThis: in dev Next ricarica i moduli ad ogni HMR e non
// vogliamo accumulare connessioni LISTEN; in prod il singleton è unico.
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg';

// ── Tipi dei payload (combaciano con 0004_notify.sql) ────────────────────────
export type GuestStatePayload = { guest_id: string };
export type EventPhasePayload = { event_id: string; fase: string };

export type GuestStateCallback = (payload: GuestStatePayload) => void;
export type EventPhaseCallback = (payload: EventPhasePayload) => void;

// Nomi dei canali NOTIFY. DEVONO combaciare con pg_notify() in 0004_notify.sql.
const CHANNEL_GUEST_STATE = 'guest_state';
const CHANNEL_EVENT_PHASE = 'event_phase';

// Backoff di riconnessione: parte basso e raddoppia fino al cap.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

// ── Registry singleton (memoizzato su globalThis per sopravvivere all'HMR) ───
type ListenerState = {
  client: pg.Client | null;
  // true tra il primo subscribe e (eventuale) shutdown: governa il loop di reconnect.
  running: boolean;
  // true mentre una connect()/reconnect è in volo (evita connessioni doppie).
  connecting: boolean;
  reconnectDelayMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  // subscriber per-guest: guestId -> set di callback.
  guestSubs: Map<string, Set<GuestStateCallback>>;
  // subscriber globali sulla fase evento.
  phaseSubs: Set<EventPhaseCallback>;
};

const globalForListener = globalThis as unknown as {
  __totemSseListener?: ListenerState;
};

function getState(): ListenerState {
  if (globalForListener.__totemSseListener) return globalForListener.__totemSseListener;
  const state: ListenerState = {
    client: null,
    running: false,
    connecting: false,
    reconnectDelayMs: RECONNECT_BASE_MS,
    reconnectTimer: null,
    guestSubs: new Map(),
    phaseSubs: new Set(),
  };
  globalForListener.__totemSseListener = state;
  return state;
}

// Connection string DIRETTA per il listener (NO pgbouncer). DATABASE_URL_DIRECT
// preferita; fallback su DATABASE_URL (accettato: meglio un listener best-effort
// che nessun realtime, ma se è una URL pgbouncer i LISTEN potrebbero non
// ricevere — vedi nota in testa al file).
function directConnectionString(): string {
  const cs = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!cs) {
    throw new Error(
      'lib/sse/listener: connection string assente. Imposta DATABASE_URL_DIRECT ' +
        '(URL DIRETTA al Postgres, NON pgbouncer) per il listener LISTEN/NOTIFY; ' +
        'in mancanza si usa DATABASE_URL come fallback.',
    );
  }
  return cs;
}

// Smista una notifica `guest_state` ai subscriber del relativo guestId.
function dispatchGuestState(state: ListenerState, raw: string | undefined): void {
  if (!raw) return;
  let payload: GuestStatePayload;
  try {
    payload = JSON.parse(raw) as GuestStatePayload;
  } catch {
    return; // payload malformato: ignora (non deve mai succedere col nostro trigger).
  }
  if (!payload || typeof payload.guest_id !== 'string') return;
  const subs = state.guestSubs.get(payload.guest_id);
  if (!subs || subs.size === 0) return;
  // Copia difensiva: un cb potrebbe unsubscribe durante l'iterazione.
  for (const cb of [...subs]) {
    try {
      cb(payload);
    } catch {
      // un subscriber che lancia non deve abbattere il fan-out agli altri.
    }
  }
}

// Smista una notifica `event_phase` a tutti i subscriber globali di fase.
function dispatchEventPhase(state: ListenerState, raw: string | undefined): void {
  if (!raw) return;
  let payload: EventPhasePayload;
  try {
    payload = JSON.parse(raw) as EventPhasePayload;
  } catch {
    return;
  }
  if (!payload || typeof payload.event_id !== 'string' || typeof payload.fase !== 'string') {
    return;
  }
  for (const cb of [...state.phaseSubs]) {
    try {
      cb(payload);
    } catch {
      // idem: isola gli errori dei singoli subscriber.
    }
  }
}

// Pianifica una riconnessione con backoff esponenziale (cap). No-op se non
// `running` (shutdown) o se c'è già un timer/connect in volo.
function scheduleReconnect(state: ListenerState): void {
  if (!state.running) return;
  if (state.reconnectTimer || state.connecting) return;
  const delay = state.reconnectDelayMs;
  state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, RECONNECT_MAX_MS);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect(state);
  }, delay);
}

// Apre la connessione diretta, registra i LISTEN e installa gli handler.
// Idempotente rispetto allo stato: non apre se già connessa o in connessione.
async function connect(state: ListenerState): Promise<void> {
  if (!state.running) return;
  if (state.client || state.connecting) return;
  state.connecting = true;

  const client = new pg.Client({ connectionString: directConnectionString() });

  // 'notification': il fan-out vero. 'error'/'end': triggerano il reconnect.
  client.on('notification', (msg) => {
    if (msg.channel === CHANNEL_GUEST_STATE) {
      dispatchGuestState(state, msg.payload);
    } else if (msg.channel === CHANNEL_EVENT_PHASE) {
      dispatchEventPhase(state, msg.payload);
    }
  });

  const onDrop = () => {
    // La connessione è andata: dimentica il client e ritenta col backoff.
    if (state.client === client) {
      state.client = null;
    }
    scheduleReconnect(state);
  };
  client.on('error', onDrop);
  client.on('end', onDrop);

  try {
    await client.connect();
    await client.query(`listen ${CHANNEL_GUEST_STATE}`);
    await client.query(`listen ${CHANNEL_EVENT_PHASE}`);
    state.client = client;
    // Connessione sana: resetta il backoff per il prossimo drop.
    state.reconnectDelayMs = RECONNECT_BASE_MS;
  } catch {
    // connect/listen falliti: chiudi best-effort e ritenta col backoff.
    try {
      await client.end();
    } catch {
      // ignore
    }
    if (state.client === client) state.client = null;
    scheduleReconnect(state);
  } finally {
    state.connecting = false;
  }
}

// Garantisce che il listener sia avviato (prima subscribe in assoluto).
function ensureStarted(state: ListenerState): void {
  if (!state.running) {
    state.running = true;
  }
  if (!state.client && !state.connecting && !state.reconnectTimer) {
    void connect(state);
  }
}

/**
 * subscribeGuest(guestId, cb): registra `cb` per le notifiche `guest_state` di
 * quel guestId. Avvia il listener al primo subscribe. Ritorna una funzione di
 * unsubscribe idempotente (rimuove il cb e libera la entry se vuota).
 */
export function subscribeGuest(guestId: string, cb: GuestStateCallback): () => void {
  const state = getState();
  ensureStarted(state);

  let subs = state.guestSubs.get(guestId);
  if (!subs) {
    subs = new Set();
    state.guestSubs.set(guestId, subs);
  }
  subs.add(cb);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const set = state.guestSubs.get(guestId);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) state.guestSubs.delete(guestId);
  };
}

/**
 * subscribePhase(cb): registra `cb` per TUTTE le notifiche `event_phase`. Avvia
 * il listener al primo subscribe. Ritorna una funzione di unsubscribe idempotente.
 */
export function subscribePhase(cb: EventPhaseCallback): () => void {
  const state = getState();
  ensureStarted(state);

  state.phaseSubs.add(cb);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    state.phaseSubs.delete(cb);
  };
}

/**
 * closeListener(): per test/shutdown puliti. Ferma il loop di reconnect, chiude
 * la connessione e svuota i registry. Dopo, una nuova subscribe ri-avvia tutto.
 */
export async function closeListener(): Promise<void> {
  const state = getState();
  state.running = false;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.reconnectDelayMs = RECONNECT_BASE_MS;
  const client = state.client;
  state.client = null;
  state.guestSubs.clear();
  state.phaseSubs.clear();
  if (client) {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
