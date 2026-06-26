// POST /api/regia/settings — aggiorna i parametri dell'evento dalla dashboard (solo regia/admin).
//
// Rimpiazza supabase.rpc('update_event_settings', { ... }). Tutti i 9 parametri (oltre a
// p_event) sono OPZIONALI: la RPC aggiorna solo i campi non-null (coalesce con il valore
// corrente). Passiamo `?? null` per ogni campo assente così l'omissione = "non toccare".
import 'server-only';
import { NextResponse } from 'next/server';
import { withAuth, type AuthClaims } from '@/lib/db';
import { requireRole } from '@/lib/auth-server/guard';
import { handleError, readJson, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SettingsBody = {
  p_event?: string;
  p_prezzo_normale?: number | null;
  p_prezzo_premium?: number | null;
  p_tk_consumo_normale?: number | null;
  p_tk_consumo_premium?: number | null;
  p_tk_conv_normale?: number | null;
  p_tk_conv_premium?: number | null;
  p_tap_ticket_ogni?: number | null;
  p_durata_sessione_s?: number | null;
  p_max_tap_al_secondo?: number | null;
};

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const claims = await requireRole(req, ['regia', 'admin']);
    const body = (await readJson<SettingsBody>(req)) ?? {};

    // Ordine posizionale ESATTO della firma update_event_settings (schema 4.10).
    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query(
          'select * from public.update_event_settings($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            body.p_event,
            body.p_prezzo_normale ?? null,
            body.p_prezzo_premium ?? null,
            body.p_tk_consumo_normale ?? null,
            body.p_tk_consumo_premium ?? null,
            body.p_tk_conv_normale ?? null,
            body.p_tk_conv_premium ?? null,
            body.p_tap_ticket_ogni ?? null,
            body.p_durata_sessione_s ?? null,
            body.p_max_tap_al_secondo ?? null,
          ],
        )
        .then((r) => r.rows[0]),
    );

    return NextResponse.json(row);
  } catch (err) {
    return handleError(err);
  }
}
