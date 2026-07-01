// POST /api/regia/draw — esegue l'estrazione pesata dei vincitori (solo regia/admin).
//
// Rimpiazza supabase.rpc('run_draw', { p_event, p_n_winners, p_seed }). p_seed è opzionale
// (se assente la RPC usa random() e registra il seed scelto: l'estrazione resta riproducibile
// e verificabile dalla riga draws). La RPC rifiuta (P0001 → 400) se la fase non è ESTRAZIONE,
// se n_winners < 1, o se non ci sono ticket in gioco.
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, readJson, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);
    const body =
      (await readJson<{
        p_event?: string;
        p_n_winners?: number;
        p_seed?: number | null;
      }>(req)) ?? {};

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.run_draw($1, $2, $3)', [
          body.p_event,
          body.p_n_winners,
          body.p_seed ?? null,
        ])
        .then((r) => r.rows[0]),
    );

    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}

// GET /api/regia/draw?event=<uuid> — ultima estrazione registrata per l'evento (solo
// regia/admin). Alimenta il pannello di regia R6 (Estrazione): mostra i vincitori
// dell'ultimo run_draw senza rieseguire il sorteggio.
//
// draws è append-only (una riga per ogni run_draw): l'ULTIMA per created_at desc è
// l'estrazione corrente. Ritorna la riga (winners, seed, n_winners, created_at) o null
// se non c'è ancora stata alcuna estrazione (200, non 404: "nessuna estrazione" è uno
// stato valido del pannello). Lettura sotto RLS staff (draws_select richiede is_staff()).
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
        .query(
          `select winners, seed, n_winners, created_at
             from public.draws
            where event_id = $1
            order by created_at desc
            limit 1`,
          [event],
        )
        .then((r) => r.rows[0] ?? null),
    );

    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
