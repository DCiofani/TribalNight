// POST /api/auth/logout — chiude la sessione.
//
// Sostituisce supabase.auth.signOut(). Revoca il refresh token corrente
// (auth.refresh_tokens.revoked_at=now(), via refresh.ts::revoke) e cancella ENTRAMBI i
// cookie. Idempotente: se non c'è refresh, pulisce comunque i cookie e risponde 200 (il
// logout non deve mai fallire lato UX).
//
// Nota: l'access token (tn_at) è stateless e a TTL breve — non revocabile singolarmente.
// Cancellarne il cookie basta: il browser smette di inviarlo e la poca vita residua del JWT
// non è sfruttabile senza il cookie HttpOnly.
import 'server-only';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { revoke } from '@/lib/auth-server/refresh';
import { RT_COOKIE, clearAuthCookies } from '@/lib/auth-server/cookies';
import { sameOriginOk, errorJson } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return errorJson(403, 'forbidden');

  const current = cookies().get(RT_COOKIE)?.value;

  // Revoca best-effort: un errore lato DB non deve impedire la pulizia dei cookie.
  if (current) {
    try {
      await revoke(current);
    } catch {
      // Ignorato di proposito: il logout client-side procede comunque.
    }
  }

  const res = NextResponse.json({ ok: true });
  clearAuthCookies(res);
  return res;
}
