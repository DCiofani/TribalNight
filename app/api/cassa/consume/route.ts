// POST /api/cassa/consume — consumo al bar (-1 saldo del tipo del drink, +ticket).
//
// Mappa: select * from public.consume(p_guest, p_drink, p_idem).
// Gate UX: requireRole(['cassa','admin']). Sicurezza vera nel DB (consume fa
// `if not is_staff() then raise`). p_idem: dal body o generato server-side.
import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, readJson, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { p_guest?: unknown; p_drink?: unknown; p_idem?: unknown };

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  try {
    const claims = await requireRole(req, ['cassa', 'admin']);
    const body = await readJson<Body>(req);
    if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

    const guest = typeof body.p_guest === 'string' ? body.p_guest : '';
    const drink = typeof body.p_drink === 'string' ? body.p_drink : '';
    if (!guest || !drink) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    // p_idem è uuid nel DB: usa la chiave del client solo se ben formata
    // (idempotenza valida sui retry), altrimenti genera un uuid (niente 22P02).
    const idem = isValidUuid(body.p_idem) ? body.p_idem : randomUUID();

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.consume($1, $2, $3)', [guest, drink, idem])
        .then((r) => r.rows[0] ?? null),
    );
    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
