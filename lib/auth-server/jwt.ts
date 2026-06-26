import 'server-only';

// jwt.ts — emissione/verifica dell'ACCESS token (JWT HS256) con `jose`.
//
// L'access token è il trasporto sicuro browser<->backend dell'identità. Vive in un
// cookie HttpOnly (tn_at), TTL breve (~15min). Il suo payload ha ESATTAMENTE la forma
// dei claims Postgres (vedi claims.ts): { sub } per l'ospite, { sub, app_metadata:{role} }
// per lo staff. Dopo verifyAccess() il backend passa questi claims as-is a withAuth().
//
// HS256 = secret simmetrico (process.env.JWT_SECRET): chi firma e chi verifica è lo
// stesso servizio (monolite Next). Se in futuro si separa un auth-service dedicato si
// può passare a RS256/EdDSA (chiave pubblica per la sola verifica) — vedi MIGRATION-PLAN §5.
//
// Dipendenza: `jose`. Va in `dependencies` del package.json.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { STAFF_ROLES, type StaffRole } from './roles';
import { isValidUuid, type Claims, type GuestClaims, type StaffClaims } from './claims';

const ISSUER = 'totem';
const AUDIENCE = 'totem-api';
const ALG = 'HS256';
// Tolleranza di clock-skew tra firma e verifica (iat/exp): 5s. Evita falsi negativi se
// l'orologio del processo che verifica è leggermente sfasato da quello che ha firmato.
const CLOCK_TOLERANCE = '5s';
// TTL access token: 15 minuti. Blast-radius minimo se intercettato; il refresh opaco
// (refresh.ts) tiene viva la sessione oltre questa scadenza.
const ACCESS_TTL_SECONDS = 15 * 60;

// Risolve il secret HS256 da env. Lazy (non al load del modulo) così l'import non
// esplode in contesti dove JWT_SECRET non serve (es. tooling). Lancia se assente:
// firmare/verificare senza secret è un errore di configurazione fatale.
function getSecret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'JWT_SECRET mancante o troppo corto (min 32 char). Impostalo nelle env Railway, mai nel bundle client.'
    );
  }
  return new TextEncoder().encode(s);
}

// signAccess(claims) -> JWT firmato (stringa compatta). claims = { sub } | { sub, app_metadata:{role} }.
// Imposta iss='totem', iat e exp (15min). Il payload include i claims as-is così che,
// in fase di verifica, vengano riestratti identici e inoltrati al DB.
export async function signAccess(claims: Claims): Promise<string> {
  if (!isValidUuid(claims.sub)) {
    // auth.uid() nel DB fa cast a uuid: un sub non-UUID esploderebbe a runtime.
    throw new Error('signAccess: sub deve essere un UUID valido');
  }

  const payload: JWTPayload = { sub: claims.sub };
  const role = (claims as StaffClaims).app_metadata?.role;
  if (role) {
    if (!(STAFF_ROLES as readonly string[]).includes(role)) {
      throw new Error(`signAccess: ruolo non valido: ${role}`);
    }
    // Manteniamo la forma annidata { app_metadata: { role } } richiesta da is_staff().
    payload.app_metadata = { role };
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(getSecret());
}

// verifyAccess(token) -> Claims se firma valida + non scaduto + iss corretto; altrimenti null.
// NON lancia: un token assente/manomesso/scaduto è uno stato normale (-> 401 a monte).
// Estrae e ri-normalizza SOLO i campi del contratto (sub, app_metadata.role): campi extra
// vengono ignorati, un app_metadata.role non valido viene scartato (degrada a ospite, mai
// a uno staff non riconosciuto).
export async function verifyAccess(token: string | undefined | null): Promise<Claims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE, // deve combaciare con setAudience: rigetta token di altri aud
      algorithms: [ALG], // pin esplicito dell'algoritmo: niente alg confusion / 'none'
      clockTolerance: CLOCK_TOLERANCE,
    });

    const sub = payload.sub;
    if (!isValidUuid(sub)) return null;

    const rawRole = (payload as { app_metadata?: { role?: unknown } }).app_metadata?.role;
    if (typeof rawRole === 'string' && (STAFF_ROLES as readonly string[]).includes(rawRole)) {
      const staff: StaffClaims = { sub, app_metadata: { role: rawRole as StaffRole } };
      return staff;
    }

    const guest: GuestClaims = { sub };
    return guest;
  } catch {
    // firma invalida, scaduto, iss errato, alg non ammesso, JWT malformato -> null.
    return null;
  }
}

export { ACCESS_TTL_SECONDS };
