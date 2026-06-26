// PATCH /api/regia/drink/active — abilita/disabilita l'ordinabilità alla cassa (solo regia/admin).
//
// Rimpiazza supabase.rpc('set_drink_active', { p_drink, p_attivo }). La RPC rifiuta
// (P0001 → 400 'voce di menù inesistente') se p_drink non esiste.
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, readJson, sameOriginOk } from '../../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);
    const body = (await readJson<{ p_drink?: string; p_attivo?: boolean }>(req)) ?? {};

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.set_drink_active($1, $2)', [
          body.p_drink,
          body.p_attivo,
        ])
        .then((r) => r.rows[0]),
    );

    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
