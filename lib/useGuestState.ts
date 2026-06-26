'use client';
// Hook client-only: stato dell'ospite LETTO dal backend, mai calcolato.
//
// Due path selezionati a runtime dal flag lib/backend-mode (USE_API), MAI insieme:
//
//  • supabase (default): fetch iniziale (select) -> subscribe postgres_changes su
//    id=eq.<guestId> -> teardown con removeChannel su unmount/cambio guestId.
//    Realtime PUSH dal DB: zero polling.
//
//  • api (Fase 4 strangler): fetch iniziale GET /api/guest/[id] + REALTIME via
//    EventSource su /api/stream/guest?guest=<id> (Postgres LISTEN/NOTIFY -> SSE).
//    L'evento SSE è un puro segnale "qualcosa è cambiato" (NESSUN dato nel payload):
//    ad ogni evento — e su onopen e su visibilitychange — si fa un refetch
//    autoritativo GET /api/guest/[id] (RLS-scoped). Su errore: reconnect con backoff;
//    se EventSource non è disponibile o l'errore persiste, FALLBACK al polling 2s.
//
// In ENTRAMBI i path: shape di ritorno identica (snake_case DB -> camelCase),
// SOLA LETTURA, nessun ricalcolo client-side. Questo modulo NON importa lib/db né
// lib/auth-server (server-only): in API mode parla col backend via fetch().
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { USE_API } from '@/lib/backend-mode';
import type { GuestRow } from '@/lib/rpc';

// Colonne lette dal front-end (path supabase). SOLA LETTURA: nessun ricalcolo.
const GUEST_COLUMNS =
  'id, nome, pin, saldo_normale, saldo_premium, ticket_totali, livello_totem';

// Intervallo del polling di FALLBACK del path API: usato solo se EventSource non
// è disponibile o se lo stream SSE fallisce in modo persistente. In condizioni
// normali il realtime arriva via SSE (push), senza alcun polling.
const API_POLL_MS = 2000;

// Backoff di riconnessione dello stream SSE: parte da ~1s, raddoppia fino a un cap.
// Oltre MAX tentativi consecutivi senza un'apertura riuscita si scende al polling.
const SSE_BACKOFF_MIN_MS = 1000;
const SSE_BACKOFF_MAX_MS = 15000;
const SSE_MAX_RETRIES_BEFORE_FALLBACK = 5;

type GuestStateRow = Pick<
  GuestRow,
  | 'id'
  | 'nome'
  | 'pin'
  | 'saldo_normale'
  | 'saldo_premium'
  | 'ticket_totali'
  | 'livello_totem'
>;

export type UseGuestStateResult = {
  nome: string | null;
  pin: string | null;
  saldoNormale: number | null;
  saldoPremium: number | null;
  ticketTotali: number | null;
  livelloTotem: number | null;
  loading: boolean;
  error: Error | null;
};

const EMPTY: Omit<UseGuestStateResult, 'loading' | 'error'> = {
  nome: null,
  pin: null,
  saldoNormale: null,
  saldoPremium: null,
  ticketTotali: null,
  livelloTotem: null,
};

function project(row: GuestStateRow | null): Omit<
  UseGuestStateResult,
  'loading' | 'error'
> {
  if (!row) return EMPTY;
  return {
    nome: row.nome,
    pin: row.pin,
    saldoNormale: row.saldo_normale,
    saldoPremium: row.saldo_premium,
    ticketTotali: row.ticket_totali,
    livelloTotem: row.livello_totem,
  };
}

export function useGuestState(guestId: string | null): UseGuestStateResult {
  const [row, setRow] = useState<GuestStateRow | null>(null);
  const [loading, setLoading] = useState<boolean>(!!guestId);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!guestId) {
      setRow(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    // ── Path API (backend nuovo, Fase 4) ─────────────────────────────────────
    // Fetch iniziale + REALTIME via SSE. Polling solo come fallback. Nessun
    // supabase-js qui: si parla col backend via fetch() + EventSource.
    if (USE_API) {
      let active = true;

      // GET /api/guest/[id]: ritorna la riga guests (RLS lato server) in snake_case
      // — la stessa shape della SELECT del path supabase, quindi project() la mappa
      // uguale. 404 (RLS che non lascia passare / id inesistente) -> riga nulla.
      // credentials:'include' -> il cookie di sessione HttpOnly viaggia col fetch.
      const fetchRow = async () => {
        try {
          const res = await fetch('/api/guest/' + encodeURIComponent(guestId), {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (!active) return;
          if (res.status === 404) {
            // Riga non visibile/inesistente: azzera, non è un errore per la UI.
            setRow(null);
            setLoading(false);
            return;
          }
          if (!res.ok) {
            setError(new Error('Errore caricamento stato (' + res.status + ')'));
            setRow(null);
            setLoading(false);
            return;
          }
          const data = (await res.json()) as GuestStateRow;
          if (!active) return;
          setRow(data);
          setLoading(false);
        } catch (err) {
          // reject di rete (offline, ecc.): non lasciare lo spinner appeso.
          if (!active) return;
          setError(err as Error);
          setRow(null);
          setLoading(false);
        }
      };

      // Risorse gestite dall'effetto: vengono azzerate nel teardown. `es`/`pollTimer`
      // sono mutuamente esclusivi (o stream SSE, o polling di fallback).
      let es: EventSource | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let retries = 0;

      const clearReconnect = () => {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };

      const closeStream = () => {
        if (es) {
          es.close();
          es = null;
        }
        clearReconnect();
      };

      // FALLBACK: polling 2s. Usato se EventSource non esiste o se lo stream SSE
      // fallisce ripetutamente. Idempotente: non avvia due timer.
      const startPolling = () => {
        closeStream();
        if (pollTimer) return;
        void fetchRow();
        pollTimer = setInterval(() => {
          void fetchRow();
        }, API_POLL_MS);
      };

      // Apertura/riapertura dello stream SSE. onopen/onmessage/onerror -> refetch o
      // reconnect con backoff. Il payload SSE non porta dati: rileggiamo sempre.
      const connect = () => {
        if (!active) return;
        clearReconnect();
        try {
          es = new EventSource(
            '/api/stream/guest?guest=' + encodeURIComponent(guestId),
            { withCredentials: true },
          );
        } catch {
          // Costruttore non disponibile/errore sincrono: vai in polling.
          startPolling();
          return;
        }

        // Apertura riuscita: refetch autoritativo e reset del backoff.
        es.onopen = () => {
          if (!active) return;
          retries = 0;
          void fetchRow();
        };

        // Ogni evento (default `message` o named `state`) = trigger di refetch.
        const onSignal = () => {
          if (!active) return;
          void fetchRow();
        };
        es.onmessage = onSignal;
        es.addEventListener('state', onSignal);

        // Errore di rete/stream: il browser potrebbe già ritentare da solo, ma noi
        // chiudiamo e gestiamo il backoff esplicitamente (e il fallback al polling
        // dopo troppi tentativi falliti consecutivi).
        es.onerror = () => {
          if (!active) return;
          if (es) {
            es.close();
            es = null;
          }
          retries += 1;
          if (retries > SSE_MAX_RETRIES_BEFORE_FALLBACK) {
            // SSE non regge in questo ambiente: degrada al polling 2s.
            startPolling();
            return;
          }
          const delay = Math.min(
            SSE_BACKOFF_MAX_MS,
            SSE_BACKOFF_MIN_MS * 2 ** (retries - 1),
          );
          clearReconnect();
          reconnectTimer = setTimeout(connect, delay);
        };
      };

      // Refetch quando la tab torna visibile: copre eventi persi mentre era nascosta
      // (alcuni browser sospendono lo stream in background).
      const onVisibility = () => {
        if (!active) return;
        if (document.visibilityState === 'visible') {
          void fetchRow();
        }
      };

      // (a) Stato corrente subito (non aspettare il primo evento/apertura).
      void fetchRow();
      // (b) Realtime via SSE, con fallback a polling se non supportato.
      if (typeof EventSource === 'undefined') {
        startPolling();
      } else {
        connect();
      }
      // (c) Refetch sul ritorno in foreground.
      document.addEventListener('visibilitychange', onVisibility);

      // (d) Teardown: stop refetch + chiudi stream/timer + rimuovi listener.
      return () => {
        active = false;
        document.removeEventListener('visibilitychange', onVisibility);
        closeStream();
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    }

    // ── Path supabase (default, invariato) ──────────────────────────────────
    // Istanza per-effetto: stabile per tutta la durata della subscription.
    const supabase = createClient();
    let active = true;

    // Re-fetch della riga autoritativa dal DB. Usato per il fetch iniziale E ad
    // ogni evento realtime: il payload di postgres_changes NON include le colonne
    // GENERATED (ticket_totali) per via della replica logica, quindi rileggiamo
    // sempre la riga completa (saldi/ticket/livello coerenti). RLS → solo la propria.
    const fetchRow = async () => {
      try {
        const { data, error: selErr } = await supabase
          .from('guests')
          .select(GUEST_COLUMNS)
          .eq('id', guestId)
          .single();
        if (!active) return;
        if (selErr) {
          setError(selErr as unknown as Error);
          setRow(null);
        } else {
          setRow(data as GuestStateRow);
        }
        setLoading(false);
      } catch (err) {
        // reject di rete (offline, ecc.): non lasciare lo spinner appeso
        if (!active) return;
        setError(err as Error);
        setRow(null);
        setLoading(false);
      }
    };

    // (a) Stato corrente PRIMA di ascoltare i delta.
    void fetchRow();

    // (b) Realtime = solo trigger: su DELETE azzera, altrimenti rileggi la riga.
    const channel = supabase
      .channel('guest-state-' + guestId)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'guests',
          filter: 'id=eq.' + guestId,
        },
        (payload) => {
          if (!active) return;
          if (payload.eventType === 'DELETE') {
            setRow(null);
          } else {
            void fetchRow();
          }
        },
      )
      .subscribe();

    // (c) Teardown: stop aggiornamenti + rimozione canale (evita leak/doppie sub).
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [guestId]);

  return { ...project(row), loading, error };
}
