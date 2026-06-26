// Auth staff — wrapper sottile su supabase.auth. UNICO punto di login/ruolo cassa.
// NB: NIENTE 'server-only' — gira nel browser con la anon key (coerente con lib/rpc.ts).
// Nessun ricalcolo: il ruolo è server-authoritative (claim JWT app_metadata.role,
// settato server-side e non editabile dal client). Qui è solo UX gating.
import type { SupabaseClient } from '@supabase/supabase-js';

// Ruoli staff autorizzati alle postazioni protette (cassa/regia/admin).
// Fonte di verità: claim app_metadata.role nel JWT (settato server-side).
export const STAFF_ROLES = ['cassa', 'regia', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// Type-guard riusabile (anche da regia, M-futuri).
export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return !!role && (STAFF_ROLES as readonly string[]).includes(role);
}

// Login staff. Ritorna void on success; throw su credenziali errate (messaggio leggibile).
// NB: il successo del sign-in NON implica ruolo staff — il chiamante DEVE ricontrollare
// con getSessionRole (gating staff = seconda verifica esplicita lato pagina).
export async function staffSignIn(
  supabase: SupabaseClient,
  email: string,
  password: string,
): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw new Error(error.message || 'Credenziali non valide');
}

// Ruolo della sessione corrente (o null se non loggato / nessun claim).
// Usa getUser() (NON getSession cache): il ruolo viene riletto/validato server-side.
// Ritorna null invece di lanciare quando non c'è utente: "non loggato" è uno stato
// normale del flow cassa.
export async function getSessionRole(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const role = data.user.app_metadata?.role;
  return typeof role === 'string' ? role : null;
}

export async function signOut(supabase: SupabaseClient): Promise<void> {
  await supabase.auth.signOut();
}
