// GET /api/guest/convert-preview?event=<uuid> — anteprima conversione credito → ticket
// dell'OSPITE chiamante (sola LETTURA, guest-safe).
//
// A che serve: nel LAST_CALL l'ospite vuole vedere "quanti ticket otterrei se converto il
// mio credito residuo ORA" PRIMA di premere convert. Questa è una LETTURA/aggregazione
// server-side, NON una scrittura né un ricalcolo client: il credito → ticket resta scritto
// dalla sola RPC convert_credit (SECURITY DEFINER, fase LAST_CALL, una volta sola).
//
// Gate: requireAuth (anche OSPITE: claim { sub }). Sotto la RLS guests_select l'ospite legge
// SOLO la propria riga (auth_uid = auth.uid()), quindi non serve passare il guest_id: lo
// risolviamo dal chiamante (event_id + auth_uid = auth.uid()). I tassi di conversione vivono
// su public.events (ticket_conversione_normale / ticket_conversione_premium), leggibili da
// ogni autenticato (events_select). Il calcolo:
//   ticket_preview = saldo_normale * ticket_conversione_normale
//                  + saldo_premium * ticket_conversione_premium
// è la STESSA formula di convert_credit (0001 §4.4) — qui solo in anteprima, senza mutare
// nulla. Aggregazione fatta lato DB in una singola query (join guests × events).
//
// Ritorna { saldo_normale, saldo_premium, ticket_preview }. Se il chiamante non è un ospite
// registrato per l'evento (nessuna riga guests) → 404 { error }: il front-end tratta il caso
// come "ospite non registrato", non come errore di sistema.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PreviewRow = {
  saldo_normale: number;
  saldo_premium: number;
  ticket_preview: number;
};

export async function GET(req: Request): Promise<NextResponse> {
  // GET idempotente ma manteniamo il check same-origin come le altre route dati /api.
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  try {
    const claims = await requireAuth(req);

    const url = new URL(req.url);
    const event = url.searchParams.get('event');
    if (!isValidUuid(event)) {
      return NextResponse.json({ error: 'event non valido' }, { status: 400 });
    }

    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query<PreviewRow>(
          // Ospite del chiamante (RLS: auth_uid = auth.uid()) join i tassi dell'evento.
          // Il calcolo è int (i tassi e i saldi sono int); ::int fissa il tipo lato DB.
          `select
             g.saldo_normale,
             g.saldo_premium,
             (g.saldo_normale * e.ticket_conversione_normale
              + g.saldo_premium * e.ticket_conversione_premium)::int as ticket_preview
           from public.guests g
           join public.events e on e.id = g.event_id
           where g.event_id = $1
             and g.auth_uid = auth.uid()`,
          [event],
        )
        .then((r) => r.rows[0] ?? null),
    );

    if (!row) {
      return NextResponse.json({ error: 'ospite non registrato' }, { status: 404 });
    }
    return NextResponse.json({
      saldo_normale: Number(row.saldo_normale) || 0,
      saldo_premium: Number(row.saldo_premium) || 0,
      ticket_preview: Number(row.ticket_preview) || 0,
    });
  } catch (err) {
    return handleError(err);
  }
}
