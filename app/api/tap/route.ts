// POST /api/tap — registra il conteggio tap cumulativo dell'ospite nella sessione.
//
// Mappa: select * from public.register_taps(p_session, p_count).
// Gate: requireAuth (ospite, claim { sub }). register_taps legge auth.uid() e valida
// la sessione + il tetto anti-cheat lato server. p_count è CUMULATIVO (non un delta).
// Body: { p_session, p_count }.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, readJson, sameOriginOk } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { p_session?: unknown; p_count?: unknown };

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  try {
    const claims = await requireAuth(req);
    const body = await readJson<Body>(req);
    if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

    const session = typeof body.p_session === 'string' ? body.p_session : '';
    if (!session) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    // p_count è int4 nel DB: deve stare in [0, 2147483647], altrimenti 22003 (overflow).
    // Coercizione esistente (Math.trunc(Number(...))) + bound espliciti.
    const count = Math.trunc(Number(body.p_count));
    if (!Number.isFinite(count) || count < 0 || count > 2147483647) {
      return NextResponse.json({ error: 'count non valido' }, { status: 400 });
    }

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.register_taps($1, $2)', [session, count])
        .then((r) => r.rows[0] ?? null),
    );
    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
