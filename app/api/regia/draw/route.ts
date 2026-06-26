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
