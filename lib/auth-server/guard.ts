import 'server-only';

// guard.ts — estrazione + gate dei claims nelle route handler (App Router, runtime nodejs).
//
// Pipeline di ogni richiesta autenticata:
//   getClaims(req)  -> Claims | null   (legge cookie tn_at o Authorization: Bearer, verifica JWT)
//   requireAuth(req) -> Claims | throw  (401 se nessun claim valido)
//   requireRole(req, roles) -> Claims | throw (403 se non staff col ruolo richiesto)
//
// IMPORTANTE — questo gate è UX/difesa-in-profondità, NON la sicurezza vera. L'autorizzazione
// autoritativa resta NEL DB: le RPC fanno `if not is_staff() then raise`, e la RLS scoping
// gira con i claims iniettati via withAuth(). Anche bypassando questo guard, il DB rigetta.
// Per questo i claims, una volta estratti, vanno passati AS-IS a withAuth(): il backend non
// re-implementa mai l'autorizzazione (modello PostgREST).
//
// Cookie name: tn_at (access token). Il fallback su header Authorization: Bearer <jwt>
// (per chiamate non-browser: test e2e HTTP, curl) è DISABILITATO di default e si abilita
// SOLO con AUTH_ALLOW_BEARER==='1'. In prod resta off: la sola via è il cookie HttpOnly,
// così un token leakato in un header/log non è spendibile e non si aggira il SameSite.

import { verifyAccess } from './jwt';
import { isStaffClaims, type Claims } from './claims';
import { STAFF_ROLES, type StaffRole } from './roles';

export { STAFF_ROLES };
export type { StaffRole };

// Nome del cookie access token (HttpOnly, impostato dalle route /api/auth/*).
export const ACCESS_COOKIE = 'tn_at';

// Errore tipizzato con status HTTP: le route lo intercettano e rispondono col codice giusto.
// (Evita di accoppiare guard.ts a NextResponse: il chiamante decide come serializzare.)
export class AuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

// Forma minima di richiesta che ci serve: headers (per cookie + Authorization).
// Compatibile con NextRequest e con la Request standard (Web Fetch API).
type RequestLike = {
  headers: { get(name: string): string | null };
  // NextRequest espone anche req.cookies.get(name); lo usiamo se presente, con fallback
  // al parsing dell'header Cookie per la Request standard.
  cookies?: { get(name: string): { value: string } | undefined };
};

// Estrae il token grezzo: prima il cookie tn_at, poi Authorization: Bearer.
function extractToken(req: RequestLike): string | null {
  // 1) NextRequest.cookies (se disponibile)
  const fromNextCookie = req.cookies?.get(ACCESS_COOKIE)?.value;
  if (fromNextCookie) return fromNextCookie;

  // 2) header Cookie grezzo (Request standard)
  const cookieHeader = req.headers.get('cookie');
  if (cookieHeader) {
    const fromHeader = parseCookie(cookieHeader, ACCESS_COOKIE);
    if (fromHeader) return fromHeader;
  }

  // 3) Authorization: Bearer <jwt> — solo se esplicitamente abilitato (off in prod).
  if (process.env.AUTH_ALLOW_BEARER === '1') {
    const auth = req.headers.get('authorization');
    if (auth) {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (m) return m[1].trim();
    }
  }

  return null;
}

// Parser minimale del header Cookie (niente dipendenze): trova `name=value`.
function parseCookie(header: string, name: string): string | null {
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// getClaims(req) -> Claims | null. Verifica firma+scadenza del JWT. Non lancia.
export async function getClaims(req: RequestLike): Promise<Claims | null> {
  const token = extractToken(req);
  return verifyAccess(token);
}

// requireAuth(req) -> Claims. Lancia AuthError(401) se non autenticato.
export async function requireAuth(req: RequestLike): Promise<Claims> {
  const claims = await getClaims(req);
  if (!claims) {
    throw new AuthError(401, 'Non autenticato');
  }
  return claims;
}

// requireRole(req, roles) -> Claims. Lancia 401 se non autenticato, 403 se il ruolo
// nel claim non è tra quelli richiesti. 'admin' NON è implicitamente incluso: passalo
// esplicitamente in `roles` se l'endpoint lo ammette (es. ['cassa','admin']).
export async function requireRole(
  req: RequestLike,
  roles: readonly StaffRole[]
): Promise<Claims> {
  const claims = await requireAuth(req);
  if (!isStaffClaims(claims)) {
    throw new AuthError(403, 'Permesso negato: richiesto ruolo staff');
  }
  const role = claims.app_metadata.role;
  if (!roles.includes(role)) {
    throw new AuthError(403, `Permesso negato: ruolo ${role} non autorizzato`);
  }
  return claims;
}
