import type { SupabaseClient } from '@supabase/supabase-js';

// Deploy a EVENTO SINGOLO (OQ9): il client non passa mai event_id a mano.
// Lo risolve dalla RPC server-authoritative current_event() (schema v0.2 §4.0).
// Nota: current_event() gira come caller e dipende dalla policy events_select (to authenticated):
// senza sessione (pre sign-in) o senza eventi non-CHIUSA restituisce null. Con più eventi
// non-CHIUSA vince per fase (APERTA→LAST_CALL→ESTRAZIONE→SETUP) poi created_at desc.
export async function getCurrentEventId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.rpc('current_event');
  if (error) throw error;
  return (data as string | null) ?? null;
}
