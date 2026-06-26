// POST /api/auth/anon — emette un JWT anonimo per l'ospite.
//
// Sostituisce supabase.auth.signInAnonymously() (app/onboarding/page.tsx).
// Emette SOLO un access token con claim { sub } (NESSUN role → app_role()='guest').
// sub = randomUUID() (UUID v4 valido: auth.uid() fa cast a uuid, prelude.sql riga 17).
//
// REFRESH per l'anon: NON ne emettiamo uno.
//   Razionale: l'identità ospite è "usa e getta" e legata alla serata. Un access token
//   con TTL breve (~15min, jwt.ts) copre l'arco utile; se scade, il client richiama
//   /api/auth/anon e ottiene un nuovo sub. Il guestId reale (puntatore NON segreto) è già
//   persistito client-side in lib/guest-session.ts e ri-associato via register_guest,
//   quindi una nuova identità anonima non perde la riga guests finché il guestId è noto.
//   Evitiamo così di riempire app_auth.refresh_tokens di token usa-e-getta. (Se in futuro
//   servisse continuità più lunga, basta emettere anche un refresh con issueRefresh(sub)
//   e settare il cookie tn_rt — rotateRefresh già gestisce role=null.)
//
// Rate-limit: endpoint NON autenticato → abuso possibile (creazione massiva di identità).
// Sotto, rate-limit best-effort per-IP in memoria di processo.
//   TODO(rate-limit-store): in memoria = per-replica, non distribuito né persistente. Per
//   più repliche o garanzie forti spostare su uno store condiviso (Redis / tabella PG).
//   Per un evento singolo con 1-2 repliche è una prima barriera sufficiente.
import 'server-only';
import { NextResponse } from 'next/server';
import { buildAnonClaims } from '@/lib/auth-server/claims';
import { signAccess } from '@/lib/auth-server/jwt';
import { setAccessCookie } from '@/lib/auth-server/cookies';
import { errorJson, sameOriginOk } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Rate-limit token-bucket per-IP (best-effort, in-process) ───────────────────
const RL_MAX = 10; // richieste...
const RL_WINDOW_MS = 60_000; // ...per finestra di 60s per IP
// Cap di sicurezza: la mappa NON deve crescere illimitata (un attaccante che varia
// l'IP attendibile è raro dietro un proxy fisso, ma sotto carico anomalo l'eviction
// degli scaduti + il cap evitano una crescita di memoria non limitata).
const RL_MAX_ENTRIES = 10_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

// Eviction degli entry scaduti (lazy, ad ogni richiesta): rimuove i bucket la cui
// finestra è chiusa. Se anche così si sfora il cap, si svuota tutto (fail-safe: il
// rate-limit è best-effort, perdere lo stato significa solo ripartire dal conteggio 0).
function evictExpired(now: number): void {
  for (const [ip, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(ip);
  }
  if (buckets.size > RL_MAX_ENTRIES) buckets.clear();
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  evictExpired(now);
  const b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return false;
  }
  if (b.count >= RL_MAX) return true;
  b.count += 1;
  return false;
}

// IP attendibile del client. L'header X-Forwarded-For è una lista
// `client, proxy1, proxy2, ...` APPESA da ciascun hop: il valore più a SINISTRA è
// impostato dal client ed è quindi SPOOFABILE (basta inviare un proprio XFF). Ci si fida
// solo degli hop aggiunti dall'infrastruttura: l'IP attendibile è quello più a DESTRA
// (l'ultimo proxy davanti all'app), non il primo. In assenza di XFF si usa l'header di
// piattaforma x-real-ip. Se nulla è disponibile, 'unknown' (tutti gli sconosciuti
// condividono un bucket: cap conservativo, mai bypass del limite).
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return errorJson(403, 'forbidden');
  if (rateLimited(clientIp(req))) return errorJson(429, 'rate_limited');

  try {
    const claims = buildAnonClaims(); // { sub: <uuid v4> }
    const accessToken = await signAccess(claims);

    const res = NextResponse.json({ sub: claims.sub });
    setAccessCookie(res, accessToken);
    return res;
  } catch {
    // Es. JWT_SECRET non configurato. Niente dettagli verso il client.
    return errorJson(500, 'auth_error');
  }
}
