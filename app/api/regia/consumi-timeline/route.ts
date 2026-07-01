// GET /api/regia/consumi-timeline?event=<uuid> — serie CONSUMI per fascia oraria
// (solo regia/admin). Alimenta l'area-chart "Consumi per fascia oraria" della dashboard R1.
//
// Aggregazione SQL delle sole transazioni di CONSUMO dell'evento, raggruppate per ORA
// (troncamento a date_trunc('hour', created_at) → etichetta 'HH24:00'). Il front-end NON
// somma nulla: i conteggi per fascia arrivano già aggregati dal DB. Sola lettura sotto la
// RLS staff (tx_select richiede is_staff()): lo staff — la cassa è staff — legge tutte le
// transazioni dell'evento. La fascia è ordinata cronologicamente (order by 1).
//
// L'event_id è passato esplicitamente e validato come uuid (→ 400), coerente con
// /api/regia/stats e /api/regia/guests (la dashboard può interrogare anche eventi non attivi).
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

    // Consumi per fascia oraria: una riga per ORA con created_at, count(*) come consumi.
    // to_char(...'HH24:00') = etichetta '00:00'..'23:00'; date_trunc allinea al bucket ora.
    const rows = await withAuth(claims as AuthClaims, (c) =>
      c
        .query(
          `select to_char(date_trunc('hour', created_at), 'HH24:00') as ora,
                  count(*)::int as consumi
             from public.transactions
            where event_id = $1
              and tipo = 'consumo'
            group by date_trunc('hour', created_at)
            order by date_trunc('hour', created_at)`,
          [event],
        )
        .then((r) => r.rows),
    );

    return NextResponse.json(rows);
  } catch (err) {
    return handleError(err);
  }
}
