// POST /api/cassa/topup — ricarica consumazioni (denaro → saldo). Fase APERTA.
//
// Mappa: select * from public.topup(p_guest, p_tipo, p_qta, p_importo, p_idem).
// Gate UX: requireRole(['cassa','admin']). La sicurezza vera è nel DB: topup fa
// `if not is_staff() then raise`. Sostituisce lib/rpc.ts::topup.
// p_idem: dal body (idempotenza su retry di rete) o generato server-side.
import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, readJson, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  p_guest?: unknown;
  p_tipo?: unknown;
  p_qta?: unknown;
  p_importo?: unknown;
  p_idem?: unknown;
};

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  try {
    const claims = await requireRole(req, ['cassa', 'admin']);
    const body = await readJson<Body>(req);
    if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

    const guest = typeof body.p_guest === 'string' ? body.p_guest : '';
    const tipo = typeof body.p_tipo === 'string' ? body.p_tipo : '';
    const qta = Number(body.p_qta);
    if (!guest || !tipo || !Number.isFinite(qta)) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    // p_importo è opzionale (numeric): null se non fornito o non numerico.
    const importo = body.p_importo == null || body.p_importo === '' ? null : Number(body.p_importo);
    // p_idem è uuid nel DB: usa la chiave del client solo se ben formata
    // (idempotenza valida sui retry), altrimenti genera un uuid (niente 22P02).
    const idem = isValidUuid(body.p_idem) ? body.p_idem : randomUUID();

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.topup($1, $2, $3, $4, $5)', [
          guest,
          tipo,
          Math.trunc(qta),
          importo,
          idem,
        ])
        .then((r) => r.rows[0] ?? null),
    );
    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
