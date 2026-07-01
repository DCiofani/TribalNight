// GET /api/regia/session/leaderboard?session=<uuid> — classifica tap della sessione
// (solo regia/admin). Alimenta la leaderboard live di R3 (Sessioni).
//
// register_taps è CUMULATIVO e fa upsert su (session_id, guest_id): esiste quindi UNA sola
// riga di public.taps per coppia (sessione, ospite), il cui tap_count è già il totale
// corrente (con clamp/cap applicati lato server). Non serve alcuna aggregazione: basta
// leggere taps join guests e ordinare per tap_count desc. Il front-end NON somma nulla.
//
// Lettura sotto RLS staff (withAuth inietta i claims regia/admin): le policy taps_select /
// guests_select concedono allo staff la lettura di tutte le righe. La sessione è passata
// esplicitamente e validata come uuid (→ 400), coerente con /api/regia/stats.
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, sameOriginOk } from '../../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tetto difensivo sulle righe ritornate: la leaderboard mostra i primi in classifica,
// non serve rimandare l'intero evento. 50 copre ampiamente ogni podio/tabellone.
const LIMIT = 50;

export async function GET(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);

    const url = new URL(req.url);
    const session = (url.searchParams.get('session') ?? '').trim();
    if (!UUID_RE.test(session)) {
      return NextResponse.json({ error: 'session non valido' }, { status: 400 });
    }

    // Una riga per (session, guest): tap_count è già il totale cumulativo. Join a guests
    // per il nome; ordino per tap_count desc (tie-break su nome per stabilità), limito.
    const rows = await withAuth(claims as AuthClaims, (c) =>
      c
        .query(
          `select t.guest_id, g.nome, t.tap_count
             from public.taps t
             join public.guests g on g.id = t.guest_id
            where t.session_id = $1
            order by t.tap_count desc, g.nome asc
            limit ${LIMIT}`,
          [session],
        )
        .then((r) => r.rows),
    );

    return NextResponse.json(rows);
  } catch (err) {
    return handleError(err);
  }
}
