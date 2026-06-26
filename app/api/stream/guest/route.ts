// GET /api/stream/guest?guest=<id> — canale Server-Sent Events per lo stato ospite.
//
// Fase 4 (strangler, flagged USE_API): rimpiazza il POLLING 2s del path API con
// realtime vero. Il push arriva da Postgres LISTEN/NOTIFY (vedi lib/sse/listener,
// COMPITO A) e viene inoltrato al browser come evento SSE. Il path supabase resta
// invariato (questo endpoint non viene mai aperto in modalità supabase).
//
// AUTORIZZAZIONE (stesso modello di GET /api/guest/[id], modello PostgREST):
//   1) requireAuth(req) — 401 se non autenticato.
//   2) Si LEGGE la riga guests via withAuth() sotto la RLS del CHIAMANTE. La policy
//      guests_select è self-or-staff: l'ospite vede solo la propria riga, lo staff
//      tutte. Se la SELECT torna 0 righe (RLS che non lascia passare / id inesistente)
//      → 404, senza rivelare se l'id esiste (niente leak, stesso comportamento del GET).
//   Superato il gate, il chiamante È autorizzato a osservare quel guest.
//
// PRIVACY: l'evento SSE NON porta dati (saldi/pin). È un puro segnale "qualcosa è
// cambiato": il client, ricevuto l'evento, RILEGGE la riga via GET /api/guest/[id]
// (refetch autoritativo RLS-scoped). Stesso principio di useGuestState che rilegge
// la riga perché ticket_totali è GENERATED.
//
// LISTEN/pgbouncer: il listener (lib/sse/listener) usa una connessione PG DIRETTA
// dedicata (DATABASE_URL_DIRECT, fallback DATABASE_URL) perché LISTEN NON funziona
// con pgbouncer in transaction-mode. Qui invece la SELECT di authz resta su withAuth
// (pgbouncer), come ogni altra read.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-server/guard';
import { withAuth, type AuthClaims } from '@/lib/db';
import { subscribeGuest } from '@/lib/sse/listener';
import { handleError } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Keep-alive: un commento SSE (riga che inizia con ':') ogni ~15s tiene viva la
// connessione attraverso proxy/load-balancer che chiudono gli idle, e fa accorgere
// il client di una connessione morta. È ignorato da EventSource.
const KEEPALIVE_MS = 15000;

export async function GET(req: Request): Promise<Response> {
  try {
    const claims = await requireAuth(req);

    const guestId = new URL(req.url).searchParams.get('guest');
    if (!guestId) {
      return NextResponse.json({ error: 'parametro guest mancante' }, { status: 400 });
    }

    // Gate di autorizzazione: leggiamo la riga sotto la RLS del chiamante. 0 righe
    // → 404 (non 403): non riveliamo se l'id esiste, identico al GET /api/guest/[id].
    const row = await withAuth(claims as AuthClaims, (c) =>
      c
        .query('select id from public.guests where id = $1', [guestId])
        .then((r) => r.rows[0] ?? null),
    );
    if (!row) {
      return NextResponse.json({ error: 'non trovato' }, { status: 404 });
    }

    // ── Stream SSE ───────────────────────────────────────────────────────────
    const encoder = new TextEncoder();
    // Ref allo stato del listener: settati alla start del ReadableStream e usati
    // nel cancel per il teardown (idempotente, anche su abort precoce).
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

        // Evento iniziale: dice subito al client di fare il primo refetch
        // autoritativo (allineamento all'apertura, prima di qualunque NOTIFY).
        send('event: state\ndata: {}\n\n');

        // Sottoscrizione al canale del singolo guest. Ad ogni NOTIFY (il payload
        // server-side porta SOLO l'id, mai dati) mandiamo un segnale "state": il
        // client rilegge la riga via GET /api/guest/[id].
        unsubscribe = subscribeGuest(guestId, () => {
          send('event: state\ndata: {}\n\n');
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
