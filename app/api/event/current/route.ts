// GET /api/event/current — stato dell'evento attivo corrente: { event_id, fase }.
//
// Mappa: select current_event() per l'id, poi events.fase di quell'evento. Sostituisce
// lib/events.ts::getCurrentEventId (che legge .event_id) e alimenta getCurrentEventState
// (che legge anche .fase). La risposta è ADDITIVA: i consumer attuali leggono solo
// .event_id e NON si rompono.
//
// current_event() è INVOKER e dipende dalla policy events_select (to authenticated)
// → richiede una sessione `authenticated`, fornita da withAuth(claims). La stessa policy
// events_select consente la SELECT della fase. Risolviamo id+fase in UN'unica query (join
// con current_event()), così sono coerenti e c'è un solo round-trip.
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
    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query<{ event_id: string | null; fase: string | null }>(
          `select e.id as event_id, e.fase as fase
             from public.events e
            where e.id = public.current_event()`,
        )
        .then((r) => r.rows[0] ?? null),
    );
    // Nessun evento non-CHIUSA: event_id=null (stesso significato di prima), fase=null.
    return NextResponse.json({
      event_id: row?.event_id ?? null,
      fase: row?.fase ?? null,
    });
  } catch (err) {
    return handleError(err);
  }
}
