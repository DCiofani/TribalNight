// POST /api/auth/refresh — rotazione del refresh token.
//
// Legge il cookie tn_rt, lo passa a rotateRefresh che: verifica l'hash in
// auth.refresh_tokens, controlla non-scaduto/non-revocato/non-riusato, REVOCA il vecchio
// (replaced_by) ed emette una NUOVA coppia { access, refresh }. La rotazione ad ogni uso è
// la mitigazione anti-replay: un refresh rubato e già usato risulta "consumato" →
// rotateRefresh ritorna null → 401 + clear cookie.
//
// 401 se il refresh è assente/invalido/scaduto/revocato. In tal caso PULIAMO i cookie (la
// sessione è morta: evitiamo loop di refresh su token zombie).
//
// Il ruolo NON è nel body: rotateRefresh ri-emette l'access con i claims corretti (ereditati
// dalla catena del refresh) dentro il cookie tn_at. Il client, se gli serve il ruolo
// aggiornato per la UI, chiama GET /api/auth/me. Manteniamo /refresh minimale e side-effect
// solo sui cookie.
import 'server-only';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { rotateRefresh } from '@/lib/auth-server/refresh';
import {
  RT_COOKIE,
  setAccessCookie,
  setRefreshCookie,
  clearAuthCookies,
} from '@/lib/auth-server/cookies';
import { errorJson, sameOriginOk } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return errorJson(403, 'forbidden');

  const current = cookies().get(RT_COOKIE)?.value;
  if (!current) {
    // Nessun refresh presente: non autenticato. Niente da pulire, 401 coerente.
    return errorJson(401, 'no_refresh');
  }

  try {
    const rotated = await rotateRefresh(current);
    if (!rotated) {
      // Token non valido/scaduto/riusato → sessione morta. Pulisci e 401.
      const res = errorJson(401, 'invalid_refresh');
      clearAuthCookies(res);
      return res;
    }

    const res = NextResponse.json({ ok: true });
    setAccessCookie(res, rotated.access);
    setRefreshCookie(res, rotated.refresh);
    return res;
  } catch {
    return errorJson(500, 'auth_error');
  }
}
