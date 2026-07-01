// GET /api/guest/draw-result?event=<uuid> — esito estrazione del chiamante (guest-safe).
//
// Mappa: select * from public.my_draw_result($1) (0008_draw_result).
// Gate: requireAuth (anche OSPITE: claim { sub }). La RLS su public.draws è STAFF-ONLY
// (0002_draws_select_staff), quindi l'ospite NON può leggere `draws` direttamente: l'esito
// passa dalla RPC SECURITY DEFINER my_draw_result, che ritorna SOLO l'esito del chiamante
// (risolto via auth.uid()) senza esporre i dati di altri ospiti.
//
// Ritorna { estratto, vinto, premio }: estratto=true se il sorteggio è avvenuto, vinto=true
// se il chiamante è tra i vincitori, premio=etichetta posizione (o null). Il front-end NON
// deriva mai l'esito da sé: tutto dal server.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DrawResultRow = {
  estratto: boolean;
  vinto: boolean;
  premio: string | null;
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
        .query<DrawResultRow>('select * from public.my_draw_result($1)', [event])
        .then((r) => r.rows[0] ?? null),
    );

    // La RPC ritorna sempre una riga (anche { false, false, null } per non-estratto /
    // ospite non registrato); il fallback difende da un result set vuoto imprevisto.
    return NextResponse.json(row ?? { estratto: false, vinto: false, premio: null });
  } catch (err) {
    return handleError(err);
  }
}
