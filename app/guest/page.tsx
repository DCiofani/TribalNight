// Schermata OSPITE (spec §10) — design Claude implementato fedelmente.
// PRESENTAZIONE = componenti screens/*; LOGICA invariata: guestId + useGuestState
// (RLS + Realtime). Il front-end NON calcola MAI saldi/ticket/livello/fase.
//
// Cablaggio guest-merge: il MENÙ è REALE (catalogo public.drinks, sole voci visibili
// all'ospite via listVisibleDrinks) + reagisce alla FASE dell'evento (autoritativa dal
// server via getCurrentEventState / evento SSE `phase`). DrinkRow → MenuItem qui sotto.
// I MOVIMENTI restano placeholder (DEMO_TX): non esiste ancora un wrapper storico
// transazioni per l'ospite (vedi gaps). Nessun dato/somma inventato lato client.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadGuestId } from '@/lib/guest-session';
import { useGuestState } from '@/lib/useGuestState';
import { createClient } from '@/lib/supabase/client';
import { listVisibleDrinks, type DrinkRow } from '@/lib/rpc';
import { getCurrentEventState } from '@/lib/events';
import { USE_API } from '@/lib/backend-mode';
import GuestHome from '@/components/screens/GuestHome';
import GuestMenu, { type MenuItem } from '@/components/screens/GuestMenu';
import GuestMovimenti, { type Tx } from '@/components/screens/GuestMovimenti';
import GuestQR from '@/components/screens/GuestQR';

// Seed deterministico dall'id ospite → totem stabile per-ospite (SSR-safe).
function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Polling leggero del listino (sola lettura). Per l'OSPITE non possiamo usare lo
// stream SSE dei drink (/api/stream/drinks è gated requireRole cassa/regia/admin →
// 403 per un ospite): refresh periodico del menù è il meccanismo corretto e sicuro
// in entrambe le modalità (supabase / api). Intervallo blando: il menù cambia di rado.
const MENU_POLL_MS = 20000;

// Polling leggero della FASE come fallback: in USE_API la fase arriva in realtime
// dall'evento `phase` dell'EventSource del guest (/api/stream/guest); in modalità
// supabase, o se l'EventSource non è disponibile, si rilegge via getCurrentEventState
// con questo intervallo. La fase resta SEMPRE autoritativa dal DB.
const PHASE_POLL_MS = 15000;

// Tag presentazionali (colori del mockup DEMO). NB: il tag indica il TIPO di
// consumazione richiesto, NON un prezzo (il front-end non calcola nulla). Oggi tutte
// le voci richiedono 1 gettone del proprio tipo; un eventuale "GRATIS" arriverà dal
// modello dati quando esisterà (vedi gaps), qui non lo inventiamo.
const TAG_PREMIUM = { tag: '1 PREMIUM', tagColor: '#9BB6EC', tagBorder: '#D89A3E' };
const TAG_NORMALE = { tag: '1 NORMALE', tagColor: '#D8C3A6', tagBorder: '#43291A' };

// Palette di gradienti del mockup, assegnata in modo deterministico per dare a ogni
// voce un thumbnail coerente col design. Puramente estetico (nessun dato).
const SWATCHES = [
  'linear-gradient(135deg,#7A2E1E,#C2451F)',
  'linear-gradient(135deg,#C2451F,#F2B43C)',
  'linear-gradient(135deg,#7A5A1E,#E0A23C)',
  'linear-gradient(135deg,#C2551F,#F5C451)',
  'linear-gradient(135deg,#2A4A3A,#3FAE6B)',
];

// Swatch deterministico: i premium usano i toni più "blu/ricchi" in cima alla lista,
// i normali ruotano sui toni ambra/verde. Stabile per nome (no flicker tra refetch).
function swatchFor(d: DrinkRow, idx: number): string {
  if (d.tipo === 'premium') return SWATCHES[0];
  return SWATCHES[1 + (idx % (SWATCHES.length - 1))];
}

// DrinkRow (DB) → MenuItem (presentazione). Sola lettura: nessun ricalcolo.
function toMenuItem(d: DrinkRow, idx: number): MenuItem {
  const tag = d.tipo === 'premium' ? TAG_PREMIUM : TAG_NORMALE;
  return {
    name: d.nome,
    desc: d.descrizione || d.categoria || '',
    swatch: swatchFor(d, idx),
    ...tag,
  };
}

// Copy del banner per fase non-APERTA. La fase NON viene mai ricalcolata: arriva dal
// server. SETUP/APERTA non mostrano avviso (bar aperto).
const PHASE_NOTICE: Record<string, string> = {
  LAST_CALL: 'Last call: il bar è chiuso. È il momento di convertire il credito residuo in ticket.',
  ESTRAZIONE: 'Estrazione in corso: il bar è chiuso. Tieni pronto il tuo PIN.',
  CHIUSA: 'Evento concluso: il bar è chiuso. Lo stato qui sotto è quello finale.',
};

// Movimenti reali: NON esiste (ancora) un wrapper storico transazioni per l'ospite.
// Lasciamo i dati placeholder in stile design — vedi gaps. Nessuna somma inventata.
const DEMO_TX: Tx[] = [
  { icon: '🍸', iconBg: '#22315C', label: 'Negroni Tribale', time: '23:14', delta: '−1 premium', deltaColor: '#9BB6EC' },
  { icon: '🥃', iconBg: '#3A2414', label: 'Birra alla spina', time: '22:58', delta: '−1 normale', deltaColor: '#D8C3A6' },
  { icon: '⬆', iconBg: '#2A4A3A', label: 'Ricarica cassa', time: '22:30', delta: '+5 normali', deltaColor: '#34D399' },
  { icon: '🎟', iconBg: '#3A2A14', label: 'Ticket serata', time: '22:30', delta: '+12 ticket', deltaColor: '#F2B43C' },
  { icon: '🍸', iconBg: '#22315C', label: 'Spritz Savana', time: '22:05', delta: '−1 normale', deltaColor: '#D8C3A6' },
  { icon: '🥃', iconBg: '#3A2414', label: 'Mezcal Ember', time: '21:40', delta: '−1 premium', deltaColor: '#9BB6EC' },
];

type View = 'totem' | 'menu' | 'movimenti';

export default function GuestPage() {
  const router = useRouter();
  const [guestId, setGuestId] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View>('totem');
  const [showQR, setShowQR] = useState(false);

  useEffect(() => {
    const id = loadGuestId();
    if (!id) router.replace('/onboarding');
    setGuestId(id);
  }, [router]);

  const { nome, pin, saldoNormale, saldoPremium, ticketTotali, livelloTotem } = useGuestState(guestId ?? null);

  // ── Evento corrente: id + fase (autoritativi dal server) ──────────────────
  const [eventId, setEventId] = useState<string | null>(null);
  const [fase, setFase] = useState<string | null>(null);

  // ── Menù reale (sole voci visibili all'ospite) ────────────────────────────
  const [drinks, setDrinks] = useState<DrinkRow[]>([]);

  // Istanza supabase stabile per i wrapper (in API mode i wrapper non la usano, ma la
  // firma la richiede). useRef così non si ricrea ad ogni render.
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  if (supabaseRef.current === null) {
    supabaseRef.current = createClient();
  }

  // Refetch del listino: SOLA LETTURA via wrapper (branch USE_API già dentro).
  const refetchMenu = useCallback(async (evId: string, signal: () => boolean) => {
    try {
      const list = await listVisibleDrinks(supabaseRef.current!, { eventId: evId });
      if (!signal()) return;
      setDrinks(list);
    } catch {
      // Errore transitorio: non azzeriamo il menù noto; ritenta al prossimo giro.
    }
  }, []);

  // Refetch della fase (autoritativa dal server) — usato all'avvio e dal polling.
  const refetchPhase = useCallback(async (signal: () => boolean) => {
    try {
      const state = await getCurrentEventState(supabaseRef.current!);
      if (!signal()) return;
      if (state) {
        setEventId(state.event_id);
        setFase(state.fase);
      }
    } catch {
      // Errore transitorio: la fase nota resta valida; ritenta al prossimo giro.
    }
  }, []);

  // Effetto: risoluzione evento + caricamento menù + polling blando del menù.
  // Niente stream drinks per l'ospite (gated cassa/regia/admin → 403): polling blando.
  useEffect(() => {
    if (!guestId) return;
    let active = true;
    const isActive = () => active;
    let menuTimer: ReturnType<typeof setInterval> | null = null;

    (async () => {
      // 1) Risolvi evento corrente + fase iniziale (server-authoritative).
      let evId: string | null = null;
      try {
        const state = await getCurrentEventState(supabaseRef.current!);
        if (!active) return;
        if (state) {
          evId = state.event_id;
          setEventId(state.event_id);
          setFase(state.fase);
        }
      } catch {
        // Nessun evento risolto: il menù resta vuoto, lo stato wallet continua a vivere.
      }
      if (!evId) return;

      // 2) Carica subito il listino visibile e avvia il polling blando.
      await refetchMenu(evId, isActive);
      if (!active) return;
      menuTimer = setInterval(() => {
        void refetchMenu(evId!, isActive);
      }, MENU_POLL_MS);
    })();

    return () => {
      active = false;
      if (menuTimer) clearInterval(menuTimer);
    };
  }, [guestId, refetchMenu]);

  // Effetto: FASE in realtime.
  //   • USE_API: EventSource phase-only sullo stream del guest (evento `phase`).
  //     Connessione separata da quella di useGuestState (che non espone la fase):
  //     leggiamo solo `phase`. Fallback a polling se EventSource non è disponibile.
  //   • supabase (o fallback): polling leggero di getCurrentEventState.
  // In OGNI caso la fase è autoritativa dal server: qui non si ricalcola nulla.
  useEffect(() => {
    if (!guestId) return;
    let active = true;
    const isActive = () => active;

    let es: EventSource | null = null;
    let phaseTimer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (phaseTimer) return;
      phaseTimer = setInterval(() => {
        void refetchPhase(isActive);
      }, PHASE_POLL_MS);
    };

    if (USE_API && typeof EventSource !== 'undefined') {
      try {
        es = new EventSource('/api/stream/guest?guest=' + encodeURIComponent(guestId), {
          withCredentials: true,
        });
        es.addEventListener('phase', (ev) => {
          if (!active) return;
          try {
            const data = JSON.parse((ev as MessageEvent).data) as { fase?: string };
            if (data?.fase) setFase(data.fase);
          } catch {
            // Payload inatteso: ignora, la fase nota resta valida.
          }
        });
        es.onerror = () => {
          if (!active) return;
          startPolling();
        };
      } catch {
        startPolling();
      }
    } else {
      startPolling();
    }

    return () => {
      active = false;
      if (es) es.close();
      if (phaseTimer) clearInterval(phaseTimer);
    };
  }, [guestId, refetchPhase]);

  const seed = guestId ? seedFromId(guestId) : 7;
  const dash = (v: number | null) => (v == null ? '—' : v);

  // Bar chiuso se la fase NON è APERTA (né SETUP): avviso + voci attenuate nel menù.
  const barChiuso = fase != null && fase !== 'APERTA' && fase !== 'SETUP';
  const menuNotice = fase ? PHASE_NOTICE[fase] ?? null : null;

  // DrinkRow → MenuItem (sola lettura, nessun ricalcolo). Riferimento eventId per chiarezza.
  void eventId;
  const menuItems: MenuItem[] = drinks.map((d, i) => toMenuItem(d, i));

  if (showQR) {
    return <GuestQR name={nome ?? ''} pin={pin ?? '----'} onBack={() => setShowQR(false)} />;
  }
  if (view === 'menu') {
    return (
      <GuestMenu
        items={menuItems}
        notice={barChiuso ? menuNotice : null}
        onBack={() => setView('totem')}
      />
    );
  }
  if (view === 'movimenti') {
    return (
      <GuestMovimenti
        ticket={dash(ticketTotali)}
        consumazioni={`${saldoNormale ?? 0}N · ${saldoPremium ?? 0}P`}
        tx={DEMO_TX}
        onBack={() => setView('totem')}
      />
    );
  }

  return (
    <GuestHome
      name={nome ?? ''}
      ticket={dash(ticketTotali)}
      normali={dash(saldoNormale)}
      premium={dash(saldoPremium)}
      level={livelloTotem ?? 0}
      seed={seed}
      active="totem"
      onShowCassa={() => setShowQR(true)}
      onNav={(t) => setView(t)}
    />
  );
}
