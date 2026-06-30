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
