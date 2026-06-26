// server-only — utilità condivise dalle route /api/auth/*. Risposte JSON pulite,
// senza leak di dettagli interni (no stack, no messaggi DB) verso il client.
import 'server-only';
import { NextResponse } from 'next/server';

// Risposta d'errore uniforme: { error: <codice stabile> }. I codici sono pensati
// per la UI (es. distinguere "credenziali" da "rate limit"), MAI per esporre
// l'interno. Nessun dettaglio sensibile nel body.
export function errorJson(status: number, code: string): NextResponse {
  return NextResponse.json({ error: code }, { status });
}

// Parsing JSON difensivo del body: ritorna null se il body non è JSON valido
// (così l'handler risponde 400 invece di 500). Non lancia mai.
export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// Origin check anti-CSRF (difesa in profondità oltre a SameSite=Strict sui cookie auth).
// Strategia per le richieste MUTANTI (POST /api/auth/*):
//
//   1. Sec-Fetch-Site (inviato dai browser moderni, non falsificabile da JS): se vale
//      'same-origin' o 'none' (navigazione/typed-in) → consentito subito. Qualsiasi altro
//      valore ('cross-site' | 'same-site') → rifiutato.
//   2. Altrimenti, header Origin: se presente, deve combaciare con ALLOWED_ORIGIN (se
//      impostata) o con l'Host servito.
//   3. Se MANCANO sia Origin sia Sec-Fetch-Site → RIFIUTATO (no fail-open). Un browser che
//      esegue una richiesta mutante cross-origin invia sempre almeno uno dei due; l'assenza
//      di entrambi è anomala (vecchi client/CSRF tooling) e per una mutation non la fidiamo.
//      (I client legittimi non-browser — test/curl — possono settare Origin same-origin.)
export function sameOriginOk(req: Request): boolean {
  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite) {
    // 'none' = navigazione diretta/typed URL (nessun originatore cross-site).
    return secFetchSite === 'same-origin' || secFetchSite === 'none';
  }

  const origin = req.headers.get('origin');
  if (!origin) return false; // né Origin né Sec-Fetch-Site su una mutation: rifiuta.

  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed) return origin === allowed;

  const host = req.headers.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
