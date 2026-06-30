// GET /api/stream/regia?event=<id> — canale Server-Sent Events sulla FASE evento.
//
// Fase 4 (strangler, flagged USE_API): rimpiazza il POLLING del path API con
// realtime vero per la regia. Il push arriva da Postgres LISTEN/NOTIFY (canale
// `event_phase`, vedi lib/sse/listener + 0004_notify.sql) e viene inoltrato al
// browser come evento SSE `phase`. Il path supabase resta invariato (questo
// endpoint non viene mai aperto in modalità supabase).
//
// AUTORIZZAZIONE: endpoint riservato allo staff di regia. requireRole impone
//   ['regia','admin'] (401 se non autenticato, 403 se ruolo non ammesso),
//   coerente con GET /api/regia/stats. Difesa in profondità + sameOriginOk.
//
// PRIVACY: la fase è uno stato pubblico/di regia (non un dato personale), quindi
// — a differenza del canale guest — può viaggiare nel payload SSE. Inoltriamo
// SOLO { fase } (l'event_id è già noto al client, è quello che ha richiesto).
//
// FILTRO PER EVENTO: subscribePhase è un canale GLOBALE (riceve la fase di TUTTI
// gli eventi). Filtriamo lato server: inoltriamo al client solo le notifiche con
// payload.event_id === event richiesto. Così un client regia non vede mai la
// fase di un evento diverso da quello che sta osservando.
//
// LISTEN/pgbouncer: il listener (lib/sse/listener) usa una connessione PG DIRETTA
// dedicata (DATABASE_URL_DIRECT, fallback DATABASE_URL) perché LISTEN NON funziona
// con pgbouncer in transaction-mode. Qui non facciamo alcuna query: l'authz è
// puramente sul claim (ruolo), non serve toccare il DB.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { subscribePhase } from '@/lib/sse/listener';
import { handleError, sameOriginOk } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Keep-alive: un commento SSE (riga che inizia con ':') ogni ~15s tiene viva la
// connessione attraverso proxy/load-balancer che chiudono gli idle, e fa accorgere
// il client di una connessione morta. È ignorato da EventSource.
const KEEPALIVE_MS = 15000;

export async function GET(req: Request): Promise<Response> {
  if (!sameOriginOk(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    await requireRole(req, ['regia', 'admin']);

    const eventId = new URL(req.url).searchParams.get('event');
    if (!isValidUuid(eventId)) {
      return NextResponse.json(
        { error: 'parametro event mancante o non valido' },
        { status: 400 },
      );
    }

    // ── Stream SSE ───────────────────────────────────────────────────────────
    const encoder = new TextEncoder();
    // Ref allo stato del listener: settati alla start del ReadableStream e usati
    // nel cancel/abort per il teardown (idempotente, anche su abort precoce).
    let unsubscribe: (() => void) | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // Controller già chiuso (race con cancel/abort): tear down e basta.
            teardown();
          }
        };

        // Sottoscrizione al canale globale di fase. Filtriamo per event_id:
        // inoltriamo solo le notifiche dell'evento richiesto, mandando la nuova
        // fase nel payload SSE (la fase è uno stato pubblico/di regia).
        unsubscribe = subscribePhase((payload) => {
          if (payload.event_id !== eventId) return;
          send(`event: phase\ndata: ${JSON.stringify({ fase: payload.fase })}\n\n`);
        });

        // Keep-alive periodico.
        keepAlive = setInterval(() => {
          send(': keep-alive\n\n');
        }, KEEPALIVE_MS);

        // Abort lato client (tab chiusa, navigazione, es.close()): teardown pulito.
        req.signal.addEventListener('abort', () => {
          teardown();
          try {
            controller.close();
          } catch {
            // già chiuso
          }
        });

        function teardown() {
          if (closed) return;
          closed = true;
          if (keepAlive) {
            clearInterval(keepAlive);
            keepAlive = null;
          }
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        }
      },
      cancel() {
        // Il consumer ha annullato lo stream: stop keep-alive + unsubscribe.
        closed = true;
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disattiva il buffering di nginx/proxy davanti allo stream.
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
