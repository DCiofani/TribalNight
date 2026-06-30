// GET /api/regia/stats?event=<uuid> — statistiche aggregate dell'evento (solo regia/admin).
//
// Mappa: select * from public.event_stats($1) → EventStats (prima ed unica riga).
// La RPC è SECURITY DEFINER con gate is_staff() (P0001 → 400 se non staff). Il front-end
// NON calcola conteggi: fase/presenze/gettoni_venduti/ticket_totali arrivano tutti da qui.
// event_id NON è risolto via current_event(): la dashboard di regia può interrogare anche
// eventi non attivi, quindi l'id viene passato esplicitamente e validato come uuid (→ 400).
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);

    const url = new URL(req.url);
    const event = (url.searchParams.get('event') ?? '').trim();
    if (!UUID_RE.test(event)) {
      return NextResponse.json({ error: 'event non valido' }, { status: 400 });
    }

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.event_stats($1)', [event])
        .then((r) => r.rows[0] ?? null),
    );

    // Evento inesistente: event_stats non produce righe. Rispondiamo 404 (non 200 null)
    // per parità col path supabase, dove getEventStats lancia RpcError se manca la riga.
    if (!row) {
      return NextResponse.json({ error: 'evento non trovato' }, { status: 404 });
    }

    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
