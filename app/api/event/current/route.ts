// GET /api/event/current — id dell'evento attivo corrente.
//
// Mappa: select current_event(). Sostituisce lib/events.ts::getCurrentEventId.
// current_event() è INVOKER e dipende dalla policy events_select (to authenticated)
// → richiede una sessione `authenticated`, fornita da withAuth(claims).
// Gate: requireAuth (ospite o staff: qualunque autenticato).
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const claims = await requireAuth(req);
    const eventId = await withAuth(claims as AuthClaims, (c) =>
      c
        .query<{ current_event: string | null }>('select public.current_event() as current_event')
        .then((r) => r.rows[0]?.current_event ?? null),
    );
    return NextResponse.json({ event_id: eventId });
  } catch (err) {
    return handleError(err);
  }
}
