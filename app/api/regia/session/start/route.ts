// POST /api/regia/session/start — avvia una sessione di tap (solo regia/admin).
//
// Rimpiazza supabase.rpc('start_session', { p_event, p_durata }). p_durata è opzionale:
// se assente la RPC usa events.durata_sessione_s. La RPC rifiuta (P0001 → 400) se l'evento
// non è in fase APERTA o se esiste già una sessione attiva.
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, readJson, sameOriginOk } from '../../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);
    const body =
      (await readJson<{ p_event?: string; p_durata?: number | null }>(req)) ?? {};

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.start_session($1, $2)', [
          body.p_event,
          body.p_durata ?? null,
        ])
        .then((r) => r.rows[0]),
    );

    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
