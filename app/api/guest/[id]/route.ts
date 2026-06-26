// GET /api/guest/[id] — legge la riga guests per id.
//
// Mappa: select * from public.guests where id = $1 (read-through soggetto a RLS).
// La policy guests_select (schema riga 207) è self-or-staff: l'ospite vede SOLO la
// propria riga (auth_uid = auth.uid()), lo staff vede tutte. L'autorizzazione è
// quindi nel DB — qui basta requireAuth. Se la RLS non lascia passare la riga, la
// SELECT torna 0 righe → 404 (non un 403: non riveliamo se l'id esiste).
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> } | { params: { id: string } },
): Promise<NextResponse> {
  try {
    const claims = await requireAuth(req);
    // Next 15: params è una Promise; Next 14: oggetto sincrono. Gestiamo entrambi.
    const p = ctx.params as { id: string } | Promise<{ id: string }>;
    const { id } = 'then' in p ? await p : p;

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select * from public.guests where id = $1', [id])
        .then((r) => r.rows[0] ?? null),
    );

    if (!row) return NextResponse.json({ error: 'non trovato' }, { status: 404 });
    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
