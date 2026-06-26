// /api/regia/drink — gestione voci di menù (solo regia/admin).
//
//   POST   → upsert_drink(...)  crea (p_id null) o aggiorna una voce di menù.
//   DELETE → delete_drink(p_drink)  elimina una voce.
//
// Rimpiazza supabase.rpc('upsert_drink', ...) e supabase.rpc('delete_drink', ...).
// upsert_drink valida p_tipo ∈ {normale,premium} (P0001 → 400 se errato). delete_drink
// ritorna void → rispondiamo { ok: true }.
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, readJson, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UpsertBody = {
  p_event?: string;
  p_id?: string | null;
  p_nome?: string;
  p_tipo?: string;
  p_descrizione?: string | null;
  p_categoria?: string | null;
  p_immagine_url?: string | null;
  p_ordine?: number | null;
  p_visibile?: boolean | null;
  p_attivo?: boolean | null;
};

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);
    const body = (await readJson<UpsertBody>(req)) ?? {};

    // Ordine posizionale ESATTO della firma upsert_drink (schema 4.11).
    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query(
          'select * from public.upsert_drink($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            body.p_event,
            body.p_id ?? null,
            body.p_nome,
            body.p_tipo,
            body.p_descrizione ?? null,
            body.p_categoria ?? null,
            body.p_immagine_url ?? null,
            body.p_ordine ?? 0,
            body.p_visibile ?? true,
            body.p_attivo ?? true,
          ],
        )
        .then((r) => r.rows[0]),
    );

    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);
    const body = (await readJson<{ p_drink?: string }>(req)) ?? {};

    await withAuth(claims as AuthClaims, (c) =>
      c.query('select public.delete_drink($1)', [body.p_drink]),
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
