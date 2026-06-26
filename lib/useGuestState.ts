'use client';
// Hook client-only: stato dell'ospite LETTO dal backend, mai calcolato.
//
// Due path selezionati a runtime dal flag lib/backend-mode (USE_API), MAI insieme:
//
//  • supabase (default): fetch iniziale (select) -> subscribe postgres_changes su
//    id=eq.<guestId> -> teardown con removeChannel su unmount/cambio guestId.
//    Realtime PUSH dal DB: zero polling.
//
//  • api (Fase 3 strangler): fetch iniziale GET /api/guest/[id] + POLLING ogni 2s
//    (setInterval, teardown clearInterval) per riallineare. Niente WebSocket: il
//    backend nuovo non espone ancora un canale realtime.
//    TODO(SSE): Fase 4 sostituirà il polling con un Server-Sent Events / WebSocket
//    su /api/guest/[id]/stream così da eliminare il roundtrip ogni 2s.
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

// Intervallo di polling del path API. Tenuto basso per dare un feeling "live"
// in cassa/ospite senza realtime. TODO(SSE) Fase 4: rimuovere col push server.
const API_POLL_MS = 2000;

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

    // ── Path API (backend nuovo) ─────────────────────────────────────────────
    // Fetch iniziale + polling ogni API_POLL_MS. Nessun supabase-js qui.
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

      // (a) Stato corrente subito.
      void fetchRow();
      // (b) Riallineamento periodico finché il guestId è montato.
      //     TODO(SSE) Fase 4: rimpiazzare con stream push, niente setInterval.
      const timer = setInterval(() => {
        void fetchRow();
      }, API_POLL_MS);

      // (c) Teardown: stop aggiornamenti + stop polling (evita doppi timer/leak).
      return () => {
        active = false;
        clearInterval(timer);
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
