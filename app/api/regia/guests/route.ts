// GET /api/regia/guests?event=<uuid> — lista ospiti dell'evento (solo regia/admin).
//
// Alimenta il pannello di regia R8 (Ospiti): lista nome/PIN/saldi/ticket/livello con
// drawer di dettaglio. Sola lettura, NIENTE ricalcolo lato client: saldi (saldo_normale,
// saldo_premium), ticket_totali (colonna GENERATED sul DB) e livello_totem sono già
// autoritativi lato DB — il front-end si limita a mostrarli.
//
// Lettura diretta della tabella public.guests sotto RLS staff (guests_select richiede
// is_staff()): lo staff vede tutti gli ospiti dell'evento, l'ospite solo sé stesso. La
// query filtra event_id, ordina per nome e limita a 200 righe (dimensione tipica di un
// evento; oltre serve paginazione, fuori scope qui).
//
// ?guest=<uuid> OPZIONALE: se presente restringe la lista al singolo ospite (stessa shape,
// array di 0/1 elementi). Utile al drawer R8 per rileggere un ospite; la timeline tx del
// drawer riusa invece getLedger filtrato per guest, quindi qui NON tocchiamo transactions.
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);

    const url = new URL(req.url);
    const event = (url.searchParams.get('event') ?? '').trim();
    if (!UUID_RE.test(event)) {
      return NextResponse.json({ error: 'event non valido' }, { status: 400 });
    }

    // ?guest opzionale: validato come uuid solo se presente (assente → nessun filtro).
    const guestRaw = url.searchParams.get('guest');
    const guest = guestRaw === null ? null : guestRaw.trim();
    if (guest !== null && !UUID_RE.test(guest)) {
      return NextResponse.json({ error: 'guest non valido' }, { status: 400 });
    }

    const rows = await withAuth(claims as AuthClaims, (c) =>
      c
        .query(
          `select id, nome, pin, saldo_normale, saldo_premium, ticket_totali, livello_totem
             from public.guests
            where event_id = $1
              and ($2::uuid is null or id = $2::uuid)
            order by nome asc
            limit 200`,
          [event, guest],
        )
        .then((r) => r.rows),
    );

    return NextResponse.json(rows);
  } catch (err) {
    return handleError(err);
  }
}
