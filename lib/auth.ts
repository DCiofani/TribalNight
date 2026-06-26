// Auth staff — wrapper sottile. UNICO punto di login/ruolo cassa.
// NB: NIENTE 'server-only' — gira nel browser (coerente con lib/rpc.ts).
// Nessun ricalcolo: il ruolo è server-authoritative (path supabase: claim JWT
// app_metadata.role; path API: claim del cookie tn_at letto da /api/auth/me).
// Qui è solo UX gating.
//
// Fase 3 (strangler, feature-flagged): branch su USE_API. Il path supabase resta
// INVARIATO; le firme pubbliche NON cambiano. NON importiamo lib/auth-server (server-only):
// le route auth si parlano via lib/api (cookie HttpOnly gestiti dalle route).
import type { SupabaseClient } from '@supabase/supabase-js';
import { USE_API } from '@/lib/backend-mode';
import { apiGet, apiPost } from '@/lib/api';
import { RpcError } from '@/lib/rpc';

// Ruoli staff autorizzati alle postazioni protette (cassa/regia/admin).
// Fonte di verità: claim role server-side (path supabase: app_metadata.role nel JWT;
// path API: role nel claim del cookie tn_at).
export const STAFF_ROLES = ['cassa', 'regia', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// Type-guard riusabile (anche da regia, M-futuri).
export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return !!role && (STAFF_ROLES as readonly string[]).includes(role);
}

// Login staff. Ritorna void on success; throw su credenziali errate (messaggio leggibile).
// NB: il successo del sign-in NON implica ruolo staff — il chiamante DEVE ricontrollare
// con getSessionRole (gating staff = seconda verifica esplicita lato pagina).
//
// Branch USE_API:
//   - API: POST /api/auth/login { email, password } → setta i cookie HttpOnly (tn_at/tn_rt)
//     e ritorna { role }. 401 invalid_credentials → throw Error('Credenziali non valide').
//     (La route staff_users contiene solo staff: login riuscito ⇒ ruolo staff valido, ma
//     manteniamo il contratto void+richeck per non cambiare le pagine.)
//   - supabase (INVARIATO): signInWithPassword.
export async function staffSignIn(
  supabase: SupabaseClient,
  email: string,
  password: string,
): Promise<void> {
  if (USE_API) {
    try {
      await apiPost<{ role: string }>('/api/auth/login', {
        email: email.trim(),
        password,
      });
    } catch (err) {
      // Messaggio leggibile uniforme: la route ritorna code 'invalid_credentials'
      // (italiano non garantito) → normalizziamo verso il testo storico.
      if (err instanceof RpcError) {
        throw new Error('Credenziali non valide');
      }
      throw err;
    }
    return;
  }

  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw new Error(error.message || 'Credenziali non valide');
}

// Ruolo della sessione corrente (o null se non loggato / nessun claim).
// Ritorna null invece di lanciare quando non c'è utente: "non loggato" è uno stato
// normale del flow cassa.
//
// Branch USE_API:
//   - API: GET /api/auth/me → { sub, role } (role 'cassa'|'regia'|'admin' per lo staff,
//     null per l'ospite anonimo). 401 unauthenticated → null (nessuna sessione: stato
//     normale). Qualunque altro errore → null (fail-closed sul gating UX).
//   - supabase (INVARIATO): getUser() (non getSession cache) → app_metadata.role.
export async function getSessionRole(supabase: SupabaseClient): Promise<string | null> {
  if (USE_API) {
    try {
      const me = await apiGet<{ sub: string; role: string | null }>('/api/auth/me');
      return typeof me.role === 'string' ? me.role : null;
    } catch {
      // 401 (nessuna sessione) o errore di rete: trattiamo come "non loggato".
      return null;
    }
  }

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const role = data.user.app_metadata?.role;
  return typeof role === 'string' ? role : null;
}

// signOut: chiude la sessione. Idempotente, non deve mai far fallire la UX.
//
// Branch USE_API:
//   - API: POST /api/auth/logout → revoca il refresh e cancella i cookie. Errori ignorati
//     (la route stessa è best-effort; un fallimento di rete non deve bloccare il logout UX).
//   - supabase (INVARIATO): auth.signOut().
export async function signOut(supabase: SupabaseClient): Promise<void> {
  if (USE_API) {
    try {
      await apiPost<{ ok: true }>('/api/auth/logout');
    } catch {
      // Logout best-effort: ignora errori (cookie comunque non più usabili lato client).
    }
    return;
  }

  await supabase.auth.signOut();
}
