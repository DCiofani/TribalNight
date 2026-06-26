// POST /api/regia/session/close — chiude una sessione di tap e converte i tap in ticket
// (solo regia/admin). Idempotente: una sessione già 'closed' ritorna 0.
//
// Rimpiazza supabase.rpc('close_session', { p_session }). La RPC ritorna un int (totale
// ticket assegnati): lo restituiamo come { ticket } per dare un body JSON-oggetto coerente.
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
    const body = (await readJson<{ p_session?: string }>(req)) ?? {};

    // close_session(p_session) returns int → la SELECT espone la colonna omonima.
    const ticket = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select public.close_session($1) as ticket', [body.p_session])
        .then((r) => r.rows[0]?.ticket as number),
    );

    return NextResponse.json({ ticket });
  } catch (err) {
    return handleError(err);
  }
}
