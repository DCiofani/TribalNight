// Wrapper RPC tipizzati. UNICO punto da cui il client scrive.
// Niente ricalcolo: il front-end chiama la RPC e legge il risultato/Realtime.
// NB: NIENTE 'server-only' — questi wrapper girano nel browser con la anon key.
//
// Fase 3 (strangler, feature-flagged): ogni wrapper fa
//   if (USE_API) { fetch /api } else { supabase-js come oggi }.
// Il path supabase resta INVARIATO; le firme pubbliche NON cambiano (le pagine non si
// toccano). NON importiamo lib/db né lib/auth-server (server-only): l'API si parla via lib/api.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCurrentEventId } from '@/lib/events';
import { USE_API } from '@/lib/backend-mode';
import { apiGet, apiPost } from '@/lib/api';

// Shape parziale della riga public.guests usata dal front-end (lettura, mai calcolo).
export type GuestRow = {
  id: string;
  event_id: string;
  nome: string;
  pin: string;
  saldo_normale: number;
  saldo_premium: number;
  ticket_totali: number; // colonna GENERATED lato DB — sola lettura
  consumazioni_count: number;
  livello_totem: number; // 0..6, autoritativo da totem_level() lato DB
};

export type TipoConsumazione = 'normale' | 'premium';

// Shape della riga public.drinks usata dal front-end (lettura menù/cassa, mai calcolo).
// Colonne reali da supabase/migrations/0001_init.sql, tabella public.drinks.
export type DrinkRow = {
  id: string;
  event_id: string;
  nome: string;
  tipo: TipoConsumazione; // 'normale' | 'premium' (check lato DB)
  descrizione: string | null; // testo per il menù
  categoria: string | null; // es. Cocktail, Birre, Analcolici
  immagine_url: string | null;
  ordine: number; // ordinamento nel menù
  visibile: boolean; // mostrato nel menù dell'ospite
  attivo: boolean; // ordinabile alla cassa
};

// Statistiche evento aggregate per la regia (sola lettura, calcolate dal DB via RPC).
export type EventStats = {
  fase: string;
  presenze: number;
  gettoni_venduti: number;
  ticket_totali: number;
};

// Riga transactions esposta al ledger di regia (sola lettura, append-only lato DB).
// Colonne reali da supabase/migrations/0001_init.sql, tabella public.transactions.
export type LedgerRow = {
  id: string;
  created_at: string;
  tipo: 'ricarica' | 'consumo' | 'conversione' | 'tap';
  tipo_consumazione: TipoConsumazione | null; // 'normale' | 'premium' | null
  qta_delta: number; // + ricarica, - consumo
  ticket_delta: number;
  importo_euro: number | null; // valorizzato solo sulle 'ricarica'
  operatore: string | null; // auth.uid() di cassa/regia, null se ospite
  guest_id: string;
  nome: string | null; // nome ospite (LEFT JOIN guests): null se guest assente/cancellata
};

// Totali del ledger, AGGREGATI dal DB (mai ricalcolati nel client):
//   incasso_euro   = somma importo_euro delle 'ricarica'
//   gettoni_emessi = somma dei qta_delta positivi
//   ticket_emessi  = somma dei ticket_delta positivi
export type LedgerTotali = {
  incasso_euro: number;
  gettoni_emessi: number;
  ticket_emessi: number;
};

export type Ledger = { totali: LedgerTotali; righe: LedgerRow[] };

// Riga transazione dell'OSPITE per la vista MOVIMENTI (G6). Sola lettura, guest-safe:
// sono le SOLE colonne presentazionali necessarie (nessun importo €, nessun operatore).
// Il mapping riga → presentazione (icona/label/delta) avviene lato client SENZA sommare
// nulla: qta_delta/ticket_delta/tipo_consumazione sono già i valori AUTORITATIVI dal DB.
export type GuestTxRow = {
  id: string;
  created_at: string;
  tipo: 'ricarica' | 'consumo' | 'conversione' | 'tap';
  tipo_consumazione: TipoConsumazione | null; // 'normale' | 'premium' | null
  qta_delta: number; // + ricarica, - consumo
  ticket_delta: number; // + conversione/tap
};

// Anteprima conversione credito → ticket dell'ospite chiamante (sola lettura, guest-safe).
//   saldo_normale / saldo_premium — credito residuo (int, dal DB su public.guests)
//   ticket_preview — ticket che si otterrebbero convertendo ORA, calcolato con i tassi
//     dell'evento (ticket_conversione_normale/premium): stessa formula di convert_credit,
//     ma senza mutare nulla. Il client NON ricalcola: legge il numero dal server.
export type ConvertPreview = {
  saldo_normale: number;
  saldo_premium: number;
  ticket_preview: number;
};

// Errore applicativo uniforme: nasconde la differenza PostgREST/Supabase/route /api
// e porta un messaggio leggibile + il codice per i casi gestibili a UI.
export class RpcError extends Error {
  code?: string;
  details?: string;
  hint?: string;
  constructor(
    message: string,
    opts?: { code?: string; details?: string; hint?: string },
  ) {
    super(message);
    this.name = 'RpcError';
    this.code = opts?.code;
    this.details = opts?.details;
    this.hint = opts?.hint;
  }
}

function rethrow(error: {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}): never {
  throw new RpcError(error.message ?? 'Errore RPC', {
    code: error.code,
    details: error.details,
    hint: error.hint,
  });
}

// register_guest -> riga guests dell'ospite (con la propria sessione).
// Risolve l'evento corrente via current_event() (deploy evento singolo): il client
// non passa mai event_id a mano. Precondizione: sessione attiva (anche anonima).
//
// Branch USE_API:
//   - API: POST /api/guest/register { p_nome } → riga guests. La route risolve l'evento
//     server-side (current_event()); se non c'è evento risponde 400 { error: 'nessun
//     evento attivo' } → la rilanciamo come RpcError(code 'NO_EVENT') per parità col path
//     supabase (la pagina onboarding discrimina su err.code === 'NO_EVENT').
//   - supabase (INVARIATO): risolve l'evento via getCurrentEventId, poi rpc register_guest.
export async function registerGuest(
  supabase: SupabaseClient,
  nome: string,
): Promise<GuestRow> {
  if (USE_API) {
    try {
      return await apiPost<GuestRow>('/api/guest/register', { p_nome: nome.trim() });
    } catch (err) {
      // Nessun evento attivo: la route ritorna 400 con questo messaggio. Normalizziamo
      // il code su 'NO_EVENT' così la UI esistente continua a riconoscere il caso.
      if (err instanceof RpcError && /nessun evento/i.test(err.message)) {
        throw new RpcError('Nessun evento attivo', { code: 'NO_EVENT' });
      }
      throw err;
    }
  }

  const eventId = await getCurrentEventId(supabase);
  if (!eventId) {
    throw new RpcError('Nessun evento attivo', { code: 'NO_EVENT' });
  }
  const { data, error } = await supabase.rpc('register_guest', {
    p_event: eventId,
    p_nome: nome.trim(),
  });
  if (error) rethrow(error);
  if (!data) throw new RpcError('register_guest non ha restituito una riga guests');
  return data as GuestRow;
}

// topup(...) -> riga transactions. Idempotente su p_idem: ritentare con LO STESSO
// idem NON raddoppia il saldo (la RPC ritorna la transazione già scritta).
// Richiede sessione staff con ruolo cassa (gating server-side via RLS/claim).
// Il saldo aggiornato arriva via Realtime su guests: qui NON si ricalcola nulla.
//
// Branch USE_API:
//   - API: POST /api/cassa/topup { p_guest, p_tipo, p_qta, p_importo, p_idem }.
//     Il gate ruolo cassa/admin è server-side; l'errore di saldo/permesso torna come
//     RpcError dal body { error }.
//   - supabase (INVARIATO): rpc topup.
export async function topup(
  supabase: SupabaseClient,
  args: {
    guestId: string;
    tipo: TipoConsumazione;
    qta: number;
    importo: number;
    idem?: string; // default crypto.randomUUID(); passa un valore stabile per retry sicuri
  },
): Promise<unknown> {
  if (USE_API) {
    return apiPost<unknown>('/api/cassa/topup', {
      p_guest: args.guestId,
      p_tipo: args.tipo,
      p_qta: args.qta,
      p_importo: args.importo,
      p_idem: args.idem ?? crypto.randomUUID(),
    });
  }

  const { data, error } = await supabase.rpc('topup', {
    p_guest: args.guestId,
    p_tipo: args.tipo,
    p_qta: args.qta,
    p_importo: args.importo,
    p_idem: args.idem ?? crypto.randomUUID(),
  });
  if (error) rethrow(error);
  return data; // riga transactions
}

// consume(...) -> consumo al bar: -1 sul saldo del tipo del drink, +1 ticket.
// Idempotente su p_idem: ritentare con LO STESSO idem NON scala due volte il saldo
// (la RPC ritorna la consumazione già scritta). Gate server-side: sessione staff con
// ruolo cassa/admin (via RLS/claim). Il saldo aggiornato arriva via Realtime su guests:
// qui NON si ricalcola nulla lato client.
//
// Branch USE_API:
//   - API: POST /api/cassa/consume { p_guest, p_drink, p_idem }. Il gate ruolo cassa/admin
//     è server-side; l'errore di saldo/permesso torna come RpcError dal body { error }.
//   - supabase (INVARIATO): rpc consume.
export async function consume(
  supabase: SupabaseClient,
  args: {
    guestId: string;
    drinkId: string;
    idem?: string; // default crypto.randomUUID(); passa un valore stabile per retry sicuri
  },
): Promise<unknown> {
  if (USE_API) {
    return apiPost<unknown>('/api/cassa/consume', {
      p_guest: args.guestId,
      p_drink: args.drinkId,
      p_idem: args.idem ?? crypto.randomUUID(),
    });
  }

  const { data, error } = await supabase.rpc('consume', {
    p_guest: args.guestId,
    p_drink: args.drinkId,
    p_idem: args.idem ?? crypto.randomUUID(),
  });
  if (error) rethrow(error);
  return data;
}

// registerTaps(...) -> registra il conteggio tap CUMULATIVO della sessione (NON un delta:
// il client invia il totale corrente, il DB non somma). Gate: requireAuth (ospite). p_count
// è un int4 in [0, 2147483647]. Il livello totem aggiornato arriva via Realtime su guests:
// qui NON si ricalcola nulla lato client.
//
// Branch USE_API:
//   - API: POST /api/tap { p_session, p_count }. Il gate ospite (requireAuth) è server-side;
//     l'errore di permesso/validazione torna come RpcError dal body { error }.
//   - supabase (INVARIATO): rpc register_taps.
export async function registerTaps(
  supabase: SupabaseClient,
  args: {
    sessionId: string;
    count: number; // conteggio cumulativo, int4 [0, 2147483647]
  },
): Promise<unknown> {
  if (USE_API) {
    return apiPost<unknown>('/api/tap', {
      p_session: args.sessionId,
      p_count: args.count,
    });
  }

  const { data, error } = await supabase.rpc('register_taps', {
    p_session: args.sessionId,
    p_count: args.count,
  });
  if (error) rethrow(error);
  return data;
}

// getActiveSession(...) -> sessione di tap ATTIVA dell'evento, o null se non ce n'è.
// "Attiva" = tap_sessions.stato='active' AND now() <= ends_at (`ends_at` è la scadenza,
// stessa condizione con cui register_taps accetta i tap). Gate: requireAuth (ospite incluso).
// Sola LETTURA della finestra temporale dell'arena (UX): NON è un dato autoritativo di
// ticket/tap (quelli restano nel DB via register_taps/close_session).
//
// Branch USE_API:
//   - API: GET /api/session/active?event=<id> → { session_id, scadenza, secondi_rimasti }
//     o null. secondi_rimasti è calcolato lato DB (niente fiducia nell'orologio del client).
//   - supabase: SELECT diretta su tap_sessions (RLS sessions_select la consente all'ospite);
//     secondi_rimasti è derivato qui SOLO come UX (ceil dei secondi residui, clamp≥0) — non
//     è un conteggio autoritativo. maybeSingle()→null se nessuna sessione attiva.
export async function getActiveSession(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<{ session_id: string; scadenza: string; secondi_rimasti: number } | null> {
  if (USE_API) {
    return apiGet<{ session_id: string; scadenza: string; secondi_rimasti: number } | null>(
      `/api/session/active?event=${encodeURIComponent(args.eventId)}`,
    );
  }

  const nowMs = Date.now();
  const { data, error } = await supabase
    .from('tap_sessions')
    .select('id, ends_at')
    .eq('event_id', args.eventId)
    .eq('stato', 'active')
    .gte('ends_at', new Date(nowMs).toISOString())
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) rethrow(error);
  const row = data as { id: string; ends_at: string } | null;
  if (!row) return null;
  const secondi_rimasti = Math.max(
    0,
    Math.ceil((new Date(row.ends_at).getTime() - nowMs) / 1000),
  );
  return { session_id: row.id, scadenza: row.ends_at, secondi_rimasti };
}

// convertCredit(...) -> conversione finale credito -> ticket (fase LAST_CALL).
// Idempotente su p_idem: ritentare con LO STESSO idem NON converte due volte
// (la RPC ritorna la conversione già scritta). Gate self-or-staff: l'ospite può convertire
// il proprio credito, lo staff quello altrui (verificato nel DB). Il saldo/ticket aggiornato
// arriva via Realtime su guests: qui NON si ricalcola nulla lato client.
//
// Branch USE_API:
//   - API: POST /api/credit/convert { p_guest, p_idem }. Il gate self-or-staff è server-side;
//     l'errore di permesso/fase torna come RpcError dal body { error }.
//   - supabase (INVARIATO): rpc convert_credit.
export async function convertCredit(
  supabase: SupabaseClient,
  args: {
    guestId: string;
    idem?: string; // default crypto.randomUUID(); passa un valore stabile per retry sicuri
  },
): Promise<unknown> {
  if (USE_API) {
    return apiPost<unknown>('/api/credit/convert', {
      p_guest: args.guestId,
      p_idem: args.idem ?? crypto.randomUUID(),
    });
  }

  const { data, error } = await supabase.rpc('convert_credit', {
    p_guest: args.guestId,
    p_idem: args.idem ?? crypto.randomUUID(),
  });
  if (error) rethrow(error);
  return data;
}

// getConvertPreview(...) -> anteprima della conversione credito → ticket dell'OSPITE
// chiamante (fase LAST_CALL, UX): "quanti ticket otterrei convertendo il mio credito ORA?".
// Sola LETTURA/aggregazione server-side: NON scrive nulla (convert_credit resta l'unica
// scrittura) e il client NON ricalcola — legge saldi e ticket_preview dal server. Gate:
// requireAuth (ospite). ticket_preview usa gli STESSI tassi di convert_credit
// (events.ticket_conversione_normale/premium).
//
// Branch USE_API:
//   - API: GET /api/guest/convert-preview?event=<id> → { saldo_normale, saldo_premium,
//     ticket_preview }. La route risolve l'ospite dal chiamante (auth.uid()) e aggrega in SQL.
//   - supabase: DUE select dirette sotto la RLS dell'ospite — (1) la propria riga guests
//     (guests_select: auth_uid = auth.uid()), (2) i tassi dell'evento (events_select). Il
//     prodotto è aggregazione di numeri AUTORITATIVI dal DB (saldi + tassi), non un ricalcolo
//     di saldi/ticket lato client (quelli restano su public.guests). auth.uid() non è
//     disponibile qui, quindi filtriamo la guest per event_id e ci affidiamo alla RLS che
//     espone SOLO la riga del chiamante (maybeSingle → una sola riga).
export async function getConvertPreview(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<ConvertPreview> {
  if (USE_API) {
    return apiGet<ConvertPreview>(
      `/api/guest/convert-preview?event=${encodeURIComponent(args.eventId)}`,
    );
  }

  const { data: gData, error: gErr } = await supabase
    .from('guests')
    .select('saldo_normale, saldo_premium')
    .eq('event_id', args.eventId)
    .maybeSingle();
  if (gErr) rethrow(gErr);
  const g = gData as { saldo_normale: number; saldo_premium: number } | null;
  if (!g) throw new RpcError('Ospite non registrato per questo evento');

  const { data: eData, error: eErr } = await supabase
    .from('events')
    .select('ticket_conversione_normale, ticket_conversione_premium')
    .eq('id', args.eventId)
    .maybeSingle();
  if (eErr) rethrow(eErr);
  const e = eData as {
    ticket_conversione_normale: number;
    ticket_conversione_premium: number;
  } | null;
  if (!e) throw new RpcError('Evento inesistente');

  const saldo_normale = Number(g.saldo_normale) || 0;
  const saldo_premium = Number(g.saldo_premium) || 0;
  const ticket_preview =
    saldo_normale * (Number(e.ticket_conversione_normale) || 0) +
    saldo_premium * (Number(e.ticket_conversione_premium) || 0);
  return { saldo_normale, saldo_premium, ticket_preview };
}

// getGuestTransactions(...) -> storico movimenti dell'OSPITE chiamante (vista MOVIMENTI G6),
// ultime ~50 righe (created_at desc). Sola LETTURA, guest-safe: la RLS tx_select espone
// all'ospite SOLO le proprie transazioni (guest_id via auth.uid()), quindi filtriamo per
// event_id e la RLS restringe automaticamente al chiamante — NON serve passare il guest_id.
// Il client NON somma/inventa nulla: mappa queste righe REALI al type presentazionale.
//
// Branch USE_API:
//   - API: GET /api/guest/transactions?event=<id> → GuestTxRow[] (gate requireAuth server-side,
//     ospite incluso; la RLS filtra alle sole righe del chiamante).
//   - supabase: select diretta su transactions sotto la policy tx_select. auth.uid() non è
//     disponibile qui, quindi filtriamo per event_id e ci affidiamo alla RLS che espone SOLO
//     le righe del chiamante (identico approccio a getConvertPreview).
export async function getGuestTransactions(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<GuestTxRow[]> {
  if (USE_API) {
    return apiGet<GuestTxRow[]>(
      `/api/guest/transactions?event=${encodeURIComponent(args.eventId)}`,
    );
  }

  const { data, error } = await supabase
    .from('transactions')
    .select('id, created_at, tipo, tipo_consumazione, qta_delta, ticket_delta')
    .eq('event_id', args.eventId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) rethrow(error);
  return (data as GuestTxRow[] | null) ?? [];
}

// lookupGuestByPin -> riga guests dell'ospite col PIN dato, o null se non esiste.
// SELECT DIRETTA (non RPC): consentita allo staff dalla policy RLS guests_select (is_staff).
// Lookup MIRATO (un solo PIN per volta, filtrato su event_id+pin): non espone l'elenco PIN.
// Sola lettura: nessun ricalcolo client-side. eventId è passato esplicito (la pagina lo ha
// già da getCurrentEventId) per evitare una RPC current_event() ad ogni tentativo.
// maybeSingle() -> null se PIN inesistente (UI: "ospite non trovato", non errore).
//
// Branch USE_API:
//   - API: GET /api/cassa/guest?pin=XXXX → riga guests (l'event_id è risolto server-side via
//     current_event(), quindi il parametro eventId qui è ignorato — la firma resta invariata
//     per non toccare le pagine). 404 { error } = PIN inesistente → null (non un errore).
//   - supabase (INVARIATO): select diretta su guests filtrata event_id+pin.
export async function lookupGuestByPin(
  supabase: SupabaseClient,
  eventId: string,
  pin: string,
): Promise<GuestRow | null> {
  if (USE_API) {
    try {
      return await apiGet<GuestRow>(`/api/cassa/guest?pin=${encodeURIComponent(pin)}`);
    } catch (err) {
      // 404 = ospite non trovato: stesso significato del maybeSingle()→null supabase.
      if (err instanceof RpcError && err.code === '404') return null;
      throw err;
    }
  }

  const { data, error } = await supabase
    .from('guests')
    .select(
      'id, event_id, nome, pin, saldo_normale, saldo_premium, ticket_totali, consumazioni_count, livello_totem',
    )
    .eq('event_id', eventId)
    .eq('pin', pin)
    .maybeSingle();
  if (error) rethrow(error);
  return (data as GuestRow | null) ?? null;
}

// listDrinks -> elenco drink ATTIVI dell'evento, ordinati per `ordine` (per il menù/cassa).
// Sola lettura: nessun ricalcolo client-side. Filtra attivo=true e ordina lato DB.
//
// Branch USE_API:
//   - API: GET /api/regia/drink?event=<id> → DrinkRow[] (gate ruolo cassa/regia/admin
//     server-side; il filtro attivo/ordinamento è nella route).
//   - supabase (INVARIATO): select diretta su drinks filtrata event_id+attivo, order ordine.
export async function listDrinks(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<DrinkRow[]> {
  if (USE_API) {
    return apiGet<DrinkRow[]>(`/api/regia/drink?event=${encodeURIComponent(args.eventId)}`);
  }

  const { data, error } = await supabase
    .from('drinks')
    .select(
      'id, event_id, nome, tipo, descrizione, categoria, immagine_url, ordine, visibile, attivo',
    )
    .eq('event_id', args.eventId)
    .eq('attivo', true)
    .order('ordine');
  if (error) rethrow(error);
  return (data as DrinkRow[] | null) ?? [];
}

// listVisibleDrinks -> elenco drink VISIBILI dell'evento (menù dell'ospite), ordinati per
// `ordine`. Sola lettura: nessun ricalcolo client-side. Filtra visibile=true e ordina lato DB.
// È leggibile anche dall'ospite (la policy drinks_select consente visibile=true).
//
// Branch USE_API:
//   - API: GET /api/regia/drink?event=<id>&scope=visible → DrinkRow[] (gate requireAuth
//     server-side; il filtro visibile/ordinamento è nella route, RLS rinforza).
//   - supabase (stile = listDrinks): select diretta su drinks filtrata event_id+visibile,
//     order ordine.
export async function listVisibleDrinks(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<DrinkRow[]> {
  if (USE_API) {
    return apiGet<DrinkRow[]>(
      `/api/regia/drink?event=${encodeURIComponent(args.eventId)}&scope=visible`,
    );
  }

  const { data, error } = await supabase
    .from('drinks')
    .select(
      'id, event_id, nome, tipo, descrizione, categoria, immagine_url, ordine, visibile, attivo',
    )
    .eq('event_id', args.eventId)
    .eq('visibile', true)
    .order('ordine');
  if (error) rethrow(error);
  return (data as DrinkRow[] | null) ?? [];
}

// listAllDrinks -> elenco COMPLETO dei drink dell'evento (gestione menù in regia), ordinati
// per `ordine`. Sola lettura: nessun filtro su attivo/visibile, nessun ricalcolo client-side.
// Gate staff (regia/admin) lato DB/route.
//
// Branch USE_API:
//   - API: GET /api/regia/drink?event=<id>&scope=all → DrinkRow[] (gate ruolo regia/admin
//     server-side; nessun filtro, ordinamento nella route).
//   - supabase (stile = listDrinks): select diretta su drinks filtrata event_id, order ordine.
export async function listAllDrinks(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<DrinkRow[]> {
  if (USE_API) {
    return apiGet<DrinkRow[]>(
      `/api/regia/drink?event=${encodeURIComponent(args.eventId)}&scope=all`,
    );
  }

  const { data, error } = await supabase
    .from('drinks')
    .select(
      'id, event_id, nome, tipo, descrizione, categoria, immagine_url, ordine, visibile, attivo',
    )
    .eq('event_id', args.eventId)
    .order('ordine');
  if (error) rethrow(error);
  return (data as DrinkRow[] | null) ?? [];
}

// getEventStats -> statistiche aggregate dell'evento per la regia (fase, presenze,
// gettoni venduti, ticket totali). Sola lettura: i conteggi sono calcolati dal DB (RPC
// event_stats), il client non somma nulla. Gate: staff (regia/admin) lato DB/route.
//
// Branch USE_API:
//   - API: GET /api/regia/stats?event=<id> → EventStats (gate ruolo regia/admin server-side).
//   - supabase (INVARIATO): rpc event_stats(p_event) → prima (unica) riga.
export async function getEventStats(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<EventStats> {
  if (USE_API) {
    return apiGet<EventStats>(`/api/regia/stats?event=${encodeURIComponent(args.eventId)}`);
  }

  const { data, error } = await supabase.rpc('event_stats', { p_event: args.eventId });
  if (error) rethrow(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new RpcError('event_stats non ha restituito statistiche');
  return row as EventStats;
}

// getLedger -> ledger/riconciliazione di regia: TOTALI aggregati (incasso €, gettoni
// emessi, ticket emessi) + le ultime ~100 righe transactions (created_at desc). Sola lettura
// sotto la RLS staff (append-only). Il front-end NON ricalcola saldi/ticket: i totali sono
// aggregati dal DB. Gate: staff (regia/admin) lato route/RLS.
//
// Branch USE_API:
//   - API: GET /api/regia/ledger?event=<id> → { totali, righe } (totali aggregati in SQL con
//     sum/filter; righe = ultime 100 desc). Gate ruolo regia/admin server-side.
//   - supabase (INVARIATO nello stile = listDrinks): DUE select dirette su transactions sotto
//     la policy tx_select (is_staff). PostgREST non espone `sum(...) filter (where ...)`, quindi:
//       1) righe  = select mirata (le colonne del ledger), order created_at desc, limit 100;
//       2) totali = select del SET COMPLETO delle sole colonne numeriche (tipo, qta_delta,
//          ticket_delta, importo_euro) e somma qui — lecito perché il set è COMPLETO
//          (nessun limit): i totali restano fedeli a tutto l'evento, non solo alle 100 righe.
export async function getLedger(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<Ledger> {
  if (USE_API) {
    return apiGet<Ledger>(`/api/regia/ledger?event=${encodeURIComponent(args.eventId)}`);
  }

  const { data: righeData, error: righeErr } = await supabase
    .from('transactions')
    .select(
      // embed guests(nome): PostgREST risolve la FK guest_id→guests e annida { nome }.
      // La RLS staff (tx_select/guests_select) copre entrambe le tabelle per la regia.
      'id, created_at, tipo, tipo_consumazione, qta_delta, ticket_delta, importo_euro, operatore, guest_id, guests(nome)',
    )
    .eq('event_id', args.eventId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (righeErr) rethrow(righeErr);

  // PostgREST annida l'embed come `guests`. Il generatore di tipi lo infersce come array
  // (relazione), quindi accettiamo sia oggetto che array e prendiamo il primo `nome`.
  // Appiattiamo su `nome` per allineare la shape LedgerRow al path /api (che fa il JOIN).
  type GuestEmbed = { nome: string } | { nome: string }[] | null;
  type RigaEmbed = Omit<LedgerRow, 'nome'> & { guests: GuestEmbed };
  const nomeOf = (g: GuestEmbed): string | null =>
    Array.isArray(g) ? (g[0]?.nome ?? null) : (g?.nome ?? null);
  const righe: LedgerRow[] = ((righeData as unknown as RigaEmbed[] | null) ?? []).map(
    ({ guests, ...r }) => ({ ...r, nome: nomeOf(guests) }),
  );

  // Set COMPLETO (niente limit) delle sole colonne numeriche → i totali coprono tutto
  // l'evento. La somma qui è aggregazione di un set completo dal DB, non un ricalcolo di
  // saldi/ticket lato client (quelli restano su public.guests, autoritativi dal DB).
  const { data: aggData, error: aggErr } = await supabase
    .from('transactions')
    .select('tipo, qta_delta, ticket_delta, importo_euro')
    .eq('event_id', args.eventId);
  if (aggErr) rethrow(aggErr);

  type AggRow = {
    tipo: string;
    qta_delta: number | null;
    ticket_delta: number | null;
    importo_euro: number | null;
  };
  const totali = ((aggData as AggRow[] | null) ?? []).reduce<LedgerTotali>(
    (acc, r) => {
      if (r.tipo === 'ricarica') acc.incasso_euro += Number(r.importo_euro) || 0;
      const q = Number(r.qta_delta) || 0;
      if (q > 0) acc.gettoni_emessi += q;
      const t = Number(r.ticket_delta) || 0;
      if (t > 0) acc.ticket_emessi += t;
      return acc;
    },
    { incasso_euro: 0, gettoni_emessi: 0, ticket_emessi: 0 },
  );

  return { totali, righe };
}

// Esito estrazione dell'OSPITE chiamante (reveal G10). Sola lettura, guest-safe:
// la RLS su public.draws è STAFF-ONLY, quindi l'ospite non legge `draws` da sé — l'esito
// arriva dalla RPC SECURITY DEFINER my_draw_result (0008), che ritorna SOLO l'esito del
// chiamante (risolto via auth.uid()) senza mai esporre i dati di altri ospiti. Il front-end
// NON calcola mai estratto/vinto: tutto dal server.
//   estratto — il sorteggio è avvenuto (esiste una draws per l'evento)
//   vinto    — il chiamante è tra i vincitori (winners[*].guest_id)
//   premio   — etichetta posizione se vinto (es. "1° posto"), altrimenti null
//
// Branch USE_API:
//   - API: GET /api/guest/draw-result?event=<id> → { estratto, vinto, premio } (gate
//     requireAuth server-side, ospite incluso).
//   - supabase (path RPC): rpc my_draw_result(p_event) → prima (unica) riga.
export type DrawResult = { estratto: boolean; vinto: boolean; premio: string | null };

export async function getMyDrawResult(
  supabase: SupabaseClient,
  args: { eventId: string },
): Promise<DrawResult> {
  if (USE_API) {
    return apiGet<DrawResult>(
      `/api/guest/draw-result?event=${encodeURIComponent(args.eventId)}`,
    );
  }

  const { data, error } = await supabase.rpc('my_draw_result', { p_event: args.eventId });
  if (error) rethrow(error);
  const row = Array.isArray(data) ? data[0] : data;
  // La RPC ritorna sempre una riga; il fallback difende da un result set vuoto imprevisto.
  return (row as DrawResult | null) ?? { estratto: false, vinto: false, premio: null };
}
