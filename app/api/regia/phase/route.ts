// POST /api/regia/phase — cambia la fase dell'evento (solo regia/admin).
//
// Rimpiazza supabase.rpc('set_phase', { p_event, p_phase }). Il gate qui è UX/difesa:
// l'autorità è la RPC (`if not is_staff('regia') then raise`) che gira dentro withAuth
// con i claims iniettati. Un client non-regia riceve P0001 → 400 'solo regia'.
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
    const body = (await readJson<{ p_event?: string; p_phase?: string }>(req)) ?? {};

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.set_phase($1, $2)', [body.p_event, body.p_phase])
        .then((r) => r.rows[0]),
    );

    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
