// POST /api/guest/register — onboarding ospite. Idempotente (la RPC ritorna la riga
// esistente se già registrato).
//
// Mappa: select * from public.register_guest(p_event, p_nome).
// Gate: requireAuth (ospite anonimo, claim { sub }). register_guest legge auth.uid()=sub
// e crea/ritorna la riga guests. Sostituisce lib/rpc.ts::registerGuest.
// Body: { p_event, p_nome } (p_event opzionale → risolto server-side via current_event()).
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, readJson, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { p_event?: unknown; p_nome?: unknown };

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  try {
    const claims = await requireAuth(req);
    const body = await readJson<Body>(req);
    if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

    const nome = typeof body.p_nome === 'string' ? body.p_nome : '';
    const eventArg = typeof body.p_event === 'string' && body.p_event ? body.p_event : null;

    const row = await withAuth(claims as AuthClaims, async (c) => {
      // event_id: dal body se fornito, altrimenti risolto server-side (evento singolo).
      const eventId =
        eventArg ??
        (await c
          .query<{ current_event: string | null }>('select public.current_event() as current_event')
          .then((r) => r.rows[0]?.current_event ?? null));
      if (!eventId) return null;
      return c
        .query('select * from public.register_guest($1, $2)', [eventId, nome])
        .then((r) => r.rows[0] ?? null);
    });

    if (!row) return NextResponse.json({ error: 'nessun evento attivo' }, { status: 400 });
    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
