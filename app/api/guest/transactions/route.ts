// GET /api/guest/transactions?event=<uuid> — storico movimenti dell'OSPITE chiamante
// (sola LETTURA, guest-safe).
//
// A che serve: la vista MOVIMENTI dell'ospite (G6) deve mostrare le SUE transazioni reali
// (ricariche, consumi, conversioni, ticket da tap) al posto dei dati placeholder. È una
// LETTURA pura: nessuna scrittura, nessun ricalcolo lato server oltre alla proiezione delle
// colonne. Il client NON somma/inventa nulla: mappa le righe REALI al type presentazionale.
//
// Gate: requireAuth (anche OSPITE: claim { sub }). La RLS tx_select (0001_init.sql) espone
// all'ospite SOLO le proprie righe (guest_id in (select g.id from guests g where
// g.auth_uid = auth.uid())), quindi NON serve passare/filtrare il guest_id: la query filtra
// per event_id e la RLS restringe automaticamente al chiamante. Lo staff vedrebbe tutte le
// righe dell'evento, ma questa route è pensata per l'ospite (parità col path supabase).
//
// Ritorna l'array delle ultime ~50 righe (created_at desc): { id, created_at, tipo,
// tipo_consumazione, qta_delta, ticket_delta }. Se l'ospite non ha movimenti → [] (empty).
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type GuestTxRow = {
  id: string;
  created_at: string;
  tipo: 'ricarica' | 'consumo' | 'conversione' | 'tap';
  tipo_consumazione: 'normale' | 'premium' | null;
  qta_delta: number;
  ticket_delta: number;
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

    const rows = await withAuth(claims as AuthClaims, (c) =>
      c
        .query<GuestTxRow>(
          // La RLS tx_select restringe alle sole righe del chiamante (guest_id via
          // auth.uid()). Nessun ricalcolo: proiettiamo solo le colonne presentazionali.
          `select id, created_at, tipo, tipo_consumazione, qta_delta, ticket_delta
             from public.transactions
             where event_id = $1
             order by created_at desc
             limit 50`,
          [event],
        )
        .then((r) => r.rows),
    );

    return NextResponse.json(rows);
  } catch (err) {
    return handleError(err);
  }
}
