// GET /api/stream/drinks?event=<id> — canale Server-Sent Events sui DRINK evento.
//
// Fase 4 (strangler, flagged USE_API): rimpiazza il POLLING del path API con
// realtime vero per il catalogo drink (cassa/regia). Il push arriva da Postgres
// LISTEN/NOTIFY (canale `drinks_changed`, vedi lib/sse/listener + 0006 trigger) e
// viene inoltrato al browser come evento SSE `drinks`. Il path supabase resta
// invariato (questo endpoint non viene mai aperto in modalità supabase).
//
// AUTORIZZAZIONE: endpoint riservato a chi opera sul catalogo. requireRole impone
//   ['cassa','regia','admin'] (401 se non autenticato, 403 se ruolo non ammesso),
//   coerente con GET /api/regia/drink?scope=active. Difesa in profondità + sameOriginOk.
//
// PRIVACY: l'evento SSE NON porta dati di catalogo. È un puro segnale "qualcosa è
// cambiato": il client, ricevuto l'evento, RILEGGE la lista via GET /api/regia/drink
// (refetch autoritativo RLS-scoped). Stesso principio del canale guest.
//
// FILTRO PER EVENTO: subscribeDrinks è già filtrato per event_id nel listener (il
// payload NOTIFY porta event_id). Sottoscriviamo solo l'evento richiesto, così un
// client non riceve mai i cambi drink di un evento diverso da quello osservato.
//
// LISTEN/pgbouncer: il listener (lib/sse/listener) usa una connessione PG DIRETTA
// dedicata (DATABASE_URL_DIRECT, fallback DATABASE_URL) perché LISTEN NON funziona
// con pgbouncer in transaction-mode. Qui non facciamo alcuna query: l'authz è
// puramente sul claim (ruolo), non serve toccare il DB.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-server/guard';
import { isValidUuid } from '@/lib/auth-server/claims';
import { subscribeDrinks } from '@/lib/sse/listener';
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
    await requireRole(req, ['cassa', 'regia', 'admin']);

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

        // Sottoscrizione al canale drink filtrato per event_id: ad ogni NOTIFY
        // (il payload server-side porta SOLO l'event_id, mai dati di catalogo)
        // mandiamo un segnale "drinks": il client rilegge la lista via
        // GET /api/regia/drink.
        unsubscribe = subscribeDrinks(eventId, () => {
          send('event: drinks\ndata: {}\n\n');
        });

        // Evento iniziale: spinge il client a fare subito il refetch autoritativo
        // del listino all'apertura dello stream (simmetria col canale guest, che
        // invia 'state' iniziale) → niente finestra di menù stale prima del 1° NOTIFY.
        send('event: drinks\ndata: {}\n\n');

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
