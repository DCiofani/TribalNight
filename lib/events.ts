import type { SupabaseClient } from '@supabase/supabase-js';
import { USE_API } from '@/lib/backend-mode';
import { apiGet } from '@/lib/api';

// Deploy a EVENTO SINGOLO (OQ9): il client non passa mai event_id a mano.
// Lo risolve dalla RPC server-authoritative current_event() (schema v0.2 §4.0).
//
// Fase 3 (strangler): branch su USE_API.
//   - API: GET /api/event/current → { event_id }. La route richiede una sessione
//     authenticated (cookie tn_at) e applica internamente la policy events_select.
//     Se non c'è evento non-CHIUSA ritorna event_id=null (stesso significato del path
//     supabase). 401 (nessuna sessione) → lasciamo propagare RpcError al chiamante.
//   - supabase (default, INVARIATO): RPC current_event() come oggi.
//
// Nota: current_event() gira come caller e dipende dalla policy events_select (to authenticated):
// senza sessione (pre sign-in) o senza eventi non-CHIUSA restituisce null. Con più eventi
// non-CHIUSA vince per fase (APERTA→LAST_CALL→ESTRAZIONE→SETUP) poi created_at desc.
export async function getCurrentEventId(supabase: SupabaseClient): Promise<string | null> {
  if (USE_API) {
    const data = await apiGet<{ event_id: string | null }>('/api/event/current');
    return data.event_id ?? null;
  }

  const { data, error } = await supabase.rpc('current_event');
  if (error) throw error;
  return (data as string | null) ?? null;
}

// getCurrentEventState -> stato dell'evento corrente { event_id, fase }, o null se non c'è
// evento non-CHIUSA. Estende getCurrentEventId con la fase (additivo): chi serve solo l'id
// continua a usare getCurrentEventId. Sola lettura: la fase è autoritativa dal DB.
//
// Fase 3 (strangler): branch su USE_API.
//   - API: GET /api/event/current → { event_id, fase }. La route richiede una sessione
//     authenticated (cookie tn_at) e applica events_select. event_id=null (e fase=null)
//     quando non c'è evento non-CHIUSA → qui restituiamo null. 401 → propaga RpcError.
//   - supabase (default): risolve l'id via current_event(), poi legge events.fase dello
//     stesso evento (la policy events_select lo consente). null se nessun evento.
export async function getCurrentEventState(
  supabase: SupabaseClient,
): Promise<{ event_id: string; fase: string } | null> {
  if (USE_API) {
    const data = await apiGet<{ event_id: string | null; fase: string | null }>(
      '/api/event/current',
    );
    if (!data.event_id || !data.fase) return null;
    return { event_id: data.event_id, fase: data.fase };
  }

  const { data: eventId, error: idErr } = await supabase.rpc('current_event');
  if (idErr) throw idErr;
  const id = (eventId as string | null) ?? null;
  if (!id) return null;

  const { data, error } = await supabase
    .from('events')
    .select('id, fase')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  const row = data as { id: string; fase: string } | null;
  if (!row) return null;
  return { event_id: row.id, fase: row.fase };
}
