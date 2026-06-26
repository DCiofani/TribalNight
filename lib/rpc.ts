// Wrapper RPC tipizzati. UNICO punto da cui il client scrive.
// Niente ricalcolo: il front-end chiama la RPC e legge il risultato/Realtime.
// NB: NIENTE 'server-only' — questi wrapper girano nel browser con la anon key.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCurrentEventId } from '@/lib/events';

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

// Errore applicativo uniforme: nasconde la differenza PostgREST/Supabase
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
export async function registerGuest(
  supabase: SupabaseClient,
  nome: string,
): Promise<GuestRow> {
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

// lookupGuestByPin -> riga guests dell'ospite col PIN dato, o null se non esiste.
// SELECT DIRETTA (non RPC): consentita allo staff dalla policy RLS guests_select (is_staff).
// Lookup MIRATO (un solo PIN per volta, filtrato su event_id+pin): non espone l'elenco PIN.
// Sola lettura: nessun ricalcolo client-side. eventId è passato esplicito (la pagina lo ha
// già da getCurrentEventId) per evitare una RPC current_event() ad ogni tentativo.
// maybeSingle() -> null se PIN inesistente (UI: "ospite non trovato", non errore).
export async function lookupGuestByPin(
  supabase: SupabaseClient,
  eventId: string,
  pin: string,
): Promise<GuestRow | null> {
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
