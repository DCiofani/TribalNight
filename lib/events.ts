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
