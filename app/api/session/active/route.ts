// GET /api/session/active?event=<uuid> — sessione di tap ATTIVA dell'evento (guest-safe).
//
// "Attiva" = tap_sessions.stato = 'active' AND now() <= ends_at (stessa condizione con cui
// register_taps (0001 §4.7) accetta i tap: `stato <> 'active' or now() > ends_at` → non
// attiva). La colonna di scadenza è `ends_at` (timestamptz).
//
// Gate: requireAuth (anche OSPITE: claim { sub }). Nessuna RPC SECURITY DEFINER necessaria —
// la policy RLS `sessions_select` (0001 §3) autorizza la SELECT su tap_sessions per ogni
// authenticated, ospite incluso → SELECT diretta via withAuth.
//
// Ritorna { session_id, scadenza (ISO), secondi_rimasti (int, clamp≥0) } della sessione
// attiva, oppure null (200) se non ce n'è nessuna. `secondi_rimasti` è calcolato lato DB
// (ceil(ends_at - now())) per non fidarsi dell'orologio del client; greatest(...,0) ne
// garantisce il clamp≥0 anche in caso di micro-skew tra la SELECT e la lettura.
//
// Il front-end NON deriva mai ticket/tap autoritativi da qui: è solo la finestra temporale
// dell'arena (UX). I conteggi veri restano nel DB (register_taps/close_session).
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { withAuth, type AuthClaims } from '@/lib/db';
import { handleError, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ActiveRow = {
  session_id: string;
  scadenza: string; // ISO (timestamptz serializzato dal driver pg)
  secondi_rimasti: number; // int, clamp≥0 (calcolato lato DB)
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

    // Una sola sessione attiva per evento è l'invariante (start_session lo impone, 0001
    // §4.6); limit 1 sulla più recente per robustezza. secondi_rimasti = ceil dei secondi
    // residui, clampato a 0. `scadenza` è ends_at in ISO.
    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query<ActiveRow>(
          `select id                                                          as session_id,
                  ends_at                                                     as scadenza,
                  greatest(ceil(extract(epoch from (ends_at - now()))), 0)::int as secondi_rimasti
             from public.tap_sessions
            where event_id = $1
              and stato = 'active'
              and now() <= ends_at
            order by started_at desc
            limit 1`,
          [event],
        )
        .then((r) => r.rows[0] ?? null),
    );

    // Nessuna sessione attiva: 200 con body null (contratto: getActiveSession → null).
    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
