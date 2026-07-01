// GET /api/regia/draws?event=<uuid> — storico compatto delle estrazioni dell'evento
// (solo regia/admin). Alimenta il pannello di regia E2 (storico estrazioni): una lista
// delle estrazioni registrate, dalla più recente, con solo i metadati e il conteggio
// vincitori — NON l'intero array winners (per quello c'è GET /api/regia/draw, singolare).
//
// draws è append-only (una riga per ogni run_draw): si legge in ordine created_at desc,
// con un limite di sicurezza (50) per una lista compatta. Il conteggio dei vincitori è
// derivato dal DB con jsonb_array_length(winners) → il client non conta nulla. Lettura
// sotto RLS staff (draws_select richiede is_staff()).
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

    const rows = await withAuth(claims as AuthClaims, (c) =>
      c
        .query(
          `select id, seed, n_winners,
                  jsonb_array_length(winners) as n, created_at
             from public.draws
            where event_id = $1
            order by created_at desc
            limit 50`,
          [event],
        )
        .then((r) => r.rows),
    );

    return NextResponse.json(rows);
  } catch (err) {
    return handleError(err);
  }
}
