// GET /api/cassa/guest?pin=XXXX — lookup ospite per PIN (postazione cassa).
//
// Mappa: select * from public.guests where event_id = current_event() and pin = $1
// (read-through soggetto a RLS). La policy guests_select lascia allo staff la lettura
// di tutte le righe; un ospite non-staff vedrebbe solo la propria → di fatto questa GET
// è utile solo allo staff. Gate UX: requireRole(staff). Sostituisce lib/rpc.ts
// lookupGuestByPin. L'event_id è risolto server-side via current_event() per non
// fidarsi di un parametro client (un solo evento attivo).
import 'server-only';
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-server/guard';
import { STAFF_ROLES } from '@/lib/auth-server/roles';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const claims = await requireRole(req, STAFF_ROLES);

    const url = new URL(req.url);
    const pin = (url.searchParams.get('pin') ?? '').trim();
    if (!pin) return NextResponse.json({ error: 'pin mancante' }, { status: 400 });

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query(
          `select * from public.guests
            where event_id = public.current_event() and pin = $1`,
          [pin],
        )
        .then((r) => r.rows[0] ?? null),
    );

    if (!row) return NextResponse.json({ error: 'non trovato' }, { status: 404 });
    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
