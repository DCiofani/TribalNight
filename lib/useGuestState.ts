'use client';
// Hook client-only: stato dell'ospite LETTO dal DB, mai calcolato.
// Pattern: fetch iniziale (select) -> subscribe postgres_changes su id=eq.<guestId>
// -> teardown con removeChannel su unmount/cambio guestId.
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { GuestRow } from '@/lib/rpc';

// Colonne lette dal front-end. SOLA LETTURA: nessun ricalcolo client-side.
const GUEST_COLUMNS =
  'id, nome, pin, saldo_normale, saldo_premium, ticket_totali, livello_totem';

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

    // Istanza per-effetto: stabile per tutta la durata della subscription.
    const supabase = createClient();
    let active = true;

    setLoading(true);
    setError(null);

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
