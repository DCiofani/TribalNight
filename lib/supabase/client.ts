// Client Supabase per il browser (componenti client).
// Usa la anon key: la sicurezza è garantita da RLS + RPC SECURITY DEFINER, non dal client.
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
