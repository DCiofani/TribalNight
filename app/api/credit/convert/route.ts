// POST /api/credit/convert — conversione finale credito → ticket (fase LAST_CALL).
//
// Mappa: select * from public.convert_credit(p_guest, p_idem).
// Gate: requireAuth. L'autorizzazione self-or-staff è VERIFICATA NEL DB (convert_credit
// fa `if not (is_staff() or v_g.auth_uid = auth.uid()) then raise`), quindi qui basta
// l'autenticazione: l'ospite può convertire la propria riga, lo staff qualunque.
// p_idem: dal body o generato server-side (idempotenza: una conversione per ospite).
import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, readJson, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { p_guest?: unknown; p_idem?: unknown };

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  try {
    const claims = await requireAuth(req);
    const body = await readJson<Body>(req);
    if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

    const guest = typeof body.p_guest === 'string' ? body.p_guest : '';
    if (!guest) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    // p_idem è uuid nel DB: usa la chiave del client solo se ben formata
    // (idempotenza valida sui retry), altrimenti genera un uuid (niente 22P02).
    const idem = isValidUuid(body.p_idem) ? body.p_idem : randomUUID();

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.convert_credit($1, $2)', [guest, idem])
        .then((r) => r.rows[0] ?? null),
    );
    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
