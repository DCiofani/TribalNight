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

// Stato dell'evento corrente restituito da getCurrentEventState. event_id/fase erano già
// presenti; prezzo_normale/prezzo_premium sono ADDITIVI (autoritativi da events.*). I prezzi
// possono essere null se il DB non li fornisce (retrocompat con backend/route più vecchi):
// il chiamante deve trattare null come "non ancora disponibili" e non inventare costanti.
export type CurrentEventState = {
  event_id: string;
  fase: string;
  prezzo_normale: number | null;
  prezzo_premium: number | null;
};

// getCurrentEventState -> stato dell'evento corrente
// { event_id, fase, prezzo_normale, prezzo_premium }, o null se non c'è evento non-CHIUSA.
// Estende getCurrentEventId con fase e prezzi (additivo): chi serve solo l'id continua a usare
// getCurrentEventId; chi legge solo event_id/fase non si rompe. Sola lettura: fase e prezzi
// sono autoritativi dal DB.
//
// Fase 3 (strangler): branch su USE_API.
//   - API: GET /api/event/current → { event_id, fase, prezzo_normale, prezzo_premium }. La
//     route richiede una sessione authenticated (cookie tn_at) e applica events_select.
//     event_id=null (e fase=null) quando non c'è evento non-CHIUSA → qui restituiamo null.
//     401 → propaga RpcError. Se i prezzi mancano (route vecchia) → null (non inventati).
//   - supabase (default): risolve l'id via current_event(), poi legge events.fase e i prezzi
//     dello stesso evento (la policy events_select lo consente). null se nessun evento.
export async function getCurrentEventState(
  supabase: SupabaseClient,
): Promise<CurrentEventState | null> {
  const toNum = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  if (USE_API) {
    const data = await apiGet<{
      event_id: string | null;
      fase: string | null;
      prezzo_normale?: number | string | null;
      prezzo_premium?: number | string | null;
    }>('/api/event/current');
    if (!data.event_id || !data.fase) return null;
    return {
      event_id: data.event_id,
      fase: data.fase,
      prezzo_normale: toNum(data.prezzo_normale),
      prezzo_premium: toNum(data.prezzo_premium),
    };
  }

  const { data: eventId, error: idErr } = await supabase.rpc('current_event');
  if (idErr) throw idErr;
  const id = (eventId as string | null) ?? null;
  if (!id) return null;

  const { data, error } = await supabase
    .from('events')
    .select('id, fase, prezzo_normale, prezzo_premium')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    id: string;
    fase: string;
    prezzo_normale: number | string | null;
    prezzo_premium: number | string | null;
  } | null;
  if (!row) return null;
  return {
    event_id: row.id,
    fase: row.fase,
    prezzo_normale: toNum(row.prezzo_normale),
    prezzo_premium: toNum(row.prezzo_premium),
  };
}
