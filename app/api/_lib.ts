// server-only — utilità condivise dalle route dati /api/* (RPC + read-through).
//
// Questo modulo NON è quello di /api/auth/_lib.ts (quello resta dedicato alle route auth):
// qui vivono gli helper specifici dello strato dati — mapping errori (AuthError → 401/403,
// errore pg da `raise exception` → 400 con messaggio utente, tutto il resto → 500 generico)
// e il riuso di sameOriginOk per le mutazioni.
//
// Pattern di ogni route (vedi MIGRATION-PLAN §1.3):
//   runtime='nodejs'; dynamic='force-dynamic';
//   (mutazioni) verifica origin con sameOriginOk;
//   claims = await requireRole(req, [...])  (o requireAuth per l'ospite);
//   body   = await req.json();
//   row    = await withAuth(claims, c => c.query('select * from public.<rpc>($1,...)', [...]));
//   return Response.json(row);
// con gli errori incanalati da handleError().
import 'server-only';
import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth-server/guard';

// Re-export per comodità delle route: stesso contratto anti-CSRF delle route auth.
export { sameOriginOk } from './auth/_lib';

// Forma minima di un errore Postgres lanciato dal driver `pg` (node-postgres).
// `code` è lo SQLSTATE. `message` è il testo: per i nostri `raise exception` è un
// messaggio utente in italiano (es. "saldo NORMALE insufficiente", "solo regia") e
// quindi safe da ritornare al client.
type PgError = { code?: string; message?: string };

function isPgError(e: unknown): e is PgError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as PgError).code === 'string'
  );
}

// SOLO P0001 (raise_exception) ha un messaggio safe da ritornare al client:
// sono i `raise exception '...'` delle RPC, testi utente scritti da noi in italiano.
// Ogni altro SQLSTATE (22P02 invalid uuid, 22003 numeric overflow, classe 23
// constraint, ecc.) porta un messaggio del driver pg in INGLESE che rivela
// tipi/colonne/struttura interna → NON va inoltrato. Quelli diventano un 400
// generico ('dato non valido'); il resto (DB giù, bug) un 500 generico.
function isRaiseExceptionPgError(code: string): boolean {
  return code === 'P0001'; // raise exception nelle RPC: messaggio utente safe
}

// handleError(err): mappa qualunque errore di una route allo status corretto.
//   - AuthError              → 401/403 col suo messaggio (già pensato per l'utente)
//   - errore pg P0001 (RAISE)→ 400 { error: <messaggio DB italiano scritto da noi> }
//   - altro errore pg        → 400 { error: 'dato non valido' } (NIENTE messaggio grezzo)
//   - tutto il resto         → 500 generico (NESSUN leak di dettagli interni)
export function handleError(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (isPgError(err) && err.code) {
    if (isRaiseExceptionPgError(err.code)) {
      // RAISE di una RPC: testo italiano scritto da noi, safe da mostrare.
      return NextResponse.json(
        { error: err.message ?? 'Operazione non consentita' },
        { status: 400 },
      );
    }
    // Altro errore pg (22P02, 22003, 23xxx, ...): input non valido lato client,
    // ma il messaggio pg è inglese e rivela dettagli interni → 400 generico.
    return NextResponse.json({ error: 'dato non valido' }, { status: 400 });
  }
  // Errore non previsto (DB irraggiungibile, bug, secret mancante): generico.
  return NextResponse.json({ error: 'errore interno' }, { status: 500 });
}

// readJson(req): parsing difensivo del body JSON. Ritorna null se non è JSON valido
// (così la route risponde 400 invece di 500). Non lancia mai.
export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
