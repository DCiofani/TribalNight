// GET /api/regia/ledger?event=<uuid> — ledger/riconciliazione cassa (solo regia/admin).
//
// Ritorna i TOTALI aggregati dell'evento (incasso €, gettoni emessi, ticket emessi) +
// le ultime ~100 righe transactions ordinate created_at desc. Sola LETTURA sotto la RLS
// staff (public.is_staff() via tx_select): le transactions sono append-only, qui nessuna
// scrittura. I totali sono AGGREGATI IN SQL (sum/filter) — il front-end NON ricalcola nulla.
// event_id passato esplicito e validato come uuid (→ 400), come /api/regia/stats: la regia
// può interrogare anche eventi non attivi.
//
// Aggregazione totali (una sola query, riga unica):
//   incasso_euro   = sum(importo_euro) filter (where tipo='ricarica')  — solo le ricariche
//                    portano importo_euro (riconciliazione cassa).
//   gettoni_emessi = sum(qta_delta) filter (where qta_delta > 0)       — i gettoni "emessi"
//                    sono i delta positivi (ricariche); i consumi hanno qta_delta<0.
//   ticket_emessi  = sum(ticket_delta) filter (where ticket_delta > 0) — solo gli accrediti
//                    di ticket (tap/consumo/conversione positivi), non eventuali storni.
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Quante righe di dettaglio restituire (le più recenti). Il ledger è una vista di
// riconciliazione "a colpo d'occhio": i totali coprono TUTTO l'evento (aggregati in SQL),
// le righe sono solo l'ultima finestra per non spingere migliaia di record al client.
const RIGHE_LIMIT = 100;

export async function GET(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);

    const url = new URL(req.url);
    const event = (url.searchParams.get('event') ?? '').trim();
    if (!UUID_RE.test(event)) {
      return NextResponse.json({ error: 'event non valido' }, { status: 400 });
    }

    const payload = await withAuth(claims as AuthClaims, async (c) => {
      // Totali su TUTTE le transactions dell'evento (aggregati in SQL, riga unica).
      // coalesce(...,0) così una tabella vuota dà 0 e non null.
      const totaliRes = await c.query(
        `select
           coalesce(sum(importo_euro) filter (where tipo = 'ricarica'), 0)::float8 as incasso_euro,
           coalesce(sum(qta_delta)    filter (where qta_delta > 0), 0)::int         as gettoni_emessi,
           coalesce(sum(ticket_delta) filter (where ticket_delta > 0), 0)::int      as ticket_emessi
         from public.transactions
         where event_id = $1`,
        [event],
      );

      // Ultime RIGHE_LIMIT righe (created_at desc), sotto la stessa RLS staff.
      // LEFT JOIN guests → aggiunge il NOME dell'ospite alla riga (null se la guest
      // fosse assente/cancellata: LEFT preserva comunque la transaction). Non altera i
      // totali (calcolati sopra su transactions da soli); prefissiamo le colonne con t.*
      // per disambiguare l'id ora che c'è la join.
      const righeRes = await c.query(
        `select t.id, t.created_at, t.tipo, t.tipo_consumazione, t.qta_delta, t.ticket_delta,
                t.importo_euro, t.operatore, t.guest_id, g.nome
         from public.transactions t
         left join public.guests g on g.id = t.guest_id
         where t.event_id = $1
         order by t.created_at desc
         limit $2`,
        [event, RIGHE_LIMIT],
      );

      const t = totaliRes.rows[0] ?? {
        incasso_euro: 0,
        gettoni_emessi: 0,
        ticket_emessi: 0,
      };
      return {
        totali: {
          incasso_euro: Number(t.incasso_euro) || 0,
          gettoni_emessi: Number(t.gettoni_emessi) || 0,
          ticket_emessi: Number(t.ticket_emessi) || 0,
        },
        righe: righeRes.rows,
      };
    });

    return NextResponse.json(payload);
  } catch (err) {
    return handleError(err);
  }
}
