// Schermata OSPITE (spec §10) — design Claude implementato fedelmente.
// PRESENTAZIONE = componenti screens/*; LOGICA invariata: guestId + useGuestState
// (RLS + Realtime). Il front-end NON calcola MAI saldi/ticket/livello/fase.
//
// Cablaggio guest-merge: il MENÙ è REALE (catalogo public.drinks, sole voci visibili
// all'ospite via listVisibleDrinks) + reagisce alla FASE dell'evento (autoritativa dal
// server via getCurrentEventState / evento SSE `phase`). DrinkRow → MenuItem qui sotto.
// I MOVIMENTI sono REALI: getGuestTransactions legge le transazioni dell'ospite (RLS
// tx_select → solo le proprie) e le mappa al type presentazionale SENZA sommare nulla.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadGuestId } from '@/lib/guest-session';
import { useGuestState } from '@/lib/useGuestState';
import { createClient } from '@/lib/supabase/client';
import {
  listVisibleDrinks,
  getActiveSession,
  registerTaps,
  convertCredit,
  getConvertPreview,
  getMyDrawResult,
  getGuestTransactions,
  RpcError,
  type DrinkRow,
  type GuestTxRow,
} from '@/lib/rpc';
import { getCurrentEventState } from '@/lib/events';
import { USE_API } from '@/lib/backend-mode';
import GuestHome from '@/components/screens/GuestHome';
import GuestMenu, { type MenuItem } from '@/components/screens/GuestMenu';
import GuestMovimenti, { type Tx } from '@/components/screens/GuestMovimenti';
import GuestQR from '@/components/screens/GuestQR';
import TapArena from '@/components/screens/TapArena';
import EsitoTap from '@/components/screens/EsitoTap';
import Conversione from '@/components/screens/Conversione';
import Reveal from '@/components/screens/Reveal';

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

// ── Tap arena (G7/G8) ────────────────────────────────────────────────────────
// Polling della sessione di tap ATTIVA: SOLO in fase APERTA (il regista lancia le
// sessioni durante il bar aperto). getActiveSession è una finestra UX: la scadenza è
// autoritativa dal server, secondi_rimasti è ricalcolato client-side dalla scadenza.
const SESSION_POLL_MS = 2000;

// Cadenza di invio del conteggio CUMULATIVO dei tap durante l'arena. registerTaps NON
// somma: inviamo il totale locale corrente; il DB clampa/cappa server-side (anti-cheat).
const TAP_FLUSH_MS = 1000;

// Attesa massima, a scadenza sessione, che il regista chiuda la sessione (close_session)
// e i ticket vengano assegnati (delta su ticket_totali via useGuestState). Oltre questo
// mostriamo comunque l'esito con i ticket noti (0 = "nessun ticket stavolta").
const CLOSE_WAIT_MS = 20000;

// ── Estrazione (G10) ───────────────────────────────────────────────────────
// Poll dell'esito estrazione (my_draw_result, guest-safe SECURITY DEFINER) mentre la
// fase è ESTRAZIONE/CHIUSA: si interroga finché estratto===true, poi si mostra win/lose.
// L'esito è SEMPRE autoritativo dal server: qui non si calcola nulla.
const DRAW_POLL_MS = 2500;

// idem STABILE per convert_credit: persistito per-ospite così un refresh a metà
// conversione NON ri-converte (la RPC è comunque idempotente su p_idem lato DB). Non
// tocca i saldi/ticket: è solo la chiave di deduplicazione della singola operazione.
const CONVERT_IDEM_KEY = 'tn_convert_idem';
function stableConvertIdem(guestId: string): string {
  const key = `${CONVERT_IDEM_KEY}:${guestId}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch {
    // storage non disponibile: idem effimero (retry entro la stessa sessione via ref chiamante).
    return crypto.randomUUID();
  }
}

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

// Polling blando dello storico movimenti (sola lettura) mentre la vista MOVIMENTI è aperta:
// le transazioni cambiano quando la cassa registra ricariche/consumi, quindi un refresh
// periodico basta. Il conteggio autoritativo resta nel DB (RLS tx_select).
const TX_POLL_MS = 8000;

// Colori delta coerenti col design (stessi toni dei tag menù/mockup). Puramente estetici.
const TX_COLOR_TICKET = '#F2B43C'; // oro → ticket (conversione/tap)
const TX_COLOR_POSITIVO = '#34D399'; // verde → ricarica (+ gettoni)
const TX_COLOR_PREMIUM = '#9BB6EC'; // blu → consumo premium
const TX_COLOR_NORMALE = '#D8C3A6'; // ambra → consumo normale

// GuestTxRow (DB) → Tx (presentazione). SOLA LETTURA: i valori (qta_delta/ticket_delta/
// tipo_consumazione) sono AUTORITATIVI dal server; qui NON si somma/inventa nulla, si
// formatta soltanto (icona/label/segno del delta già presente nella riga, orario da created_at).
function txTime(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

// Etichetta plurale coerente ("1 normale" / "2 normali") senza calcoli: solo formattazione
// del valore già fornito dal DB.
function plural(n: number, singolare: string, plurale: string): string {
  return Math.abs(n) === 1 ? singolare : plurale;
}

function toTx(row: GuestTxRow): Tx {
  const time = txTime(row.created_at);
  // Segno esplicito: usiamo il segno REALE del delta dal DB (non lo ricalcoliamo).
  const seg = (n: number) => (n > 0 ? `+${n}` : `${n}`); // n<0 porta già il '-'
  switch (row.tipo) {
    case 'ricarica':
      // Ricarica cassa: qta_delta > 0 gettoni del tipo indicato.
      return {
        icon: '⬆',
        iconBg: '#2A4A3A',
        label: 'Ricarica cassa',
        time,
        delta: `${seg(row.qta_delta)} ${plural(row.qta_delta, 'gettone', 'gettoni')}${
          row.tipo_consumazione ? ` ${row.tipo_consumazione}` : ''
        }`,
        deltaColor: TX_COLOR_POSITIVO,
      };
    case 'consumo': {
      // Consumo al bar: qta_delta < 0 sul tipo del drink. Colore per tipo consumazione.
      const premium = row.tipo_consumazione === 'premium';
      return {
        icon: '🍸',
        iconBg: premium ? '#22315C' : '#3A2414',
        label: premium ? 'Consumazione premium' : 'Consumazione normale',
        time,
        delta: `${seg(row.qta_delta)} ${row.tipo_consumazione ?? 'consumazione'}`,
        deltaColor: premium ? TX_COLOR_PREMIUM : TX_COLOR_NORMALE,
      };
    }
    case 'tap':
      // Tap arena: ticket_delta > 0 ticket guadagnati.
      return {
        icon: '✦',
        iconBg: '#3A2A14',
        label: 'Tap arena',
        time,
        delta: `${seg(row.ticket_delta)} ${plural(row.ticket_delta, 'ticket', 'ticket')}`,
        deltaColor: TX_COLOR_TICKET,
      };
    case 'conversione':
    default:
      // Conversione credito → ticket (ticket_delta > 0).
      return {
        icon: '🎟',
        iconBg: '#3A2A14',
        label: 'Conversione in ticket',
        time,
        delta: `${seg(row.ticket_delta)} ${plural(row.ticket_delta, 'ticket', 'ticket')}`,
        deltaColor: TX_COLOR_TICKET,
      };
  }
}

type View = 'totem' | 'menu' | 'movimenti' | 'tap' | 'esito';

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

  // ── Movimenti reali (storico transazioni dell'ospite) ─────────────────────
  // Caricati SOLO quando la vista MOVIMENTI è aperta (fetch on-demand + polling blando).
  // La RLS tx_select restituisce solo le righe del chiamante: qui non si somma nulla.
  const [txRows, setTxRows] = useState<GuestTxRow[]>([]);

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

  // Refetch dello storico movimenti dell'ospite: SOLA LETTURA via wrapper (branch USE_API
  // già dentro). La RLS restringe alle sole righe del chiamante; qui non si somma nulla.
  const refetchTx = useCallback(async (evId: string, signal: () => boolean) => {
    try {
      const rows = await getGuestTransactions(supabaseRef.current!, { eventId: evId });
      if (!signal()) return;
      setTxRows(rows);
    } catch {
      // Errore transitorio: non azzeriamo lo storico noto; ritenta al prossimo giro.
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

  // Effetto: storico MOVIMENTI, caricato SOLO quando la vista movimenti è aperta.
  // Fetch immediato + polling blando (le transazioni cambiano quando la cassa opera).
  // Fuori dalla vista movimenti non interroghiamo nulla (risparmio + niente dati stantii).
  useEffect(() => {
    if (view !== 'movimenti' || !eventId) return;
    let active = true;
    const isActive = () => active;

    void refetchTx(eventId, isActive);
    const timer = setInterval(() => {
      void refetchTx(eventId, isActive);
    }, TX_POLL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [view, eventId, refetchTx]);

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

  // ── Tap arena (G7) + Esito (G8) ────────────────────────────────────────────
  // Sessione di tap ATTIVA (finestra UX): id + scadenza server. secondiRimasti è
  // SEMPRE ricalcolato dalla scadenza (non un timer cieco). tapLocali è un contatore
  // locale OTTIMISTICO: i ticket VERI arrivano dal DB (delta ticket_totali) dopo
  // close_session del regista — qui NON si calcola nulla di autoritativo.
  const [session, setSession] = useState<{ sessionId: string; scadenza: string } | null>(null);
  const [secondiRimasti, setSecondiRimasti] = useState(0);
  const [tapLocali, setTapLocali] = useState(0);
  // Ref al contatore tap LIVE: gli effetti (arena tick + flush) leggono l'ultimo valore
  // senza dipendere da `tapLocali` (che cambia ad ogni tap → eviterebbe di ricreare i timer).
  const tapLocaliRef = useRef(0);
  tapLocaliRef.current = tapLocali;

  // Esito: delta ticket (dopo close_session) + tap totali della sessione.
  const [esitoPending, setEsitoPending] = useState(false);
  const [esitoTicket, setEsitoTicket] = useState(0);
  const [esitoTap, setEsitoTap] = useState(0);

  // ── Conversione (G9) ───────────────────────────────────────────────────────
  // busy/error della singola operazione convert_credit; `converted` per il post-stato
  // "Convertito ✓". I saldi tornano a 0 via useGuestState (server-authoritative): qui
  // NON li tocchiamo a mano.
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [converted, setConverted] = useState(false);
  // "Non ora": l'ospite può posticipare e navigare l'hub; resta in LAST_CALL finché la
  // fase non cambia. Non è una decisione autoritativa, solo una preferenza UX locale.
  const [convertDismissed, setConvertDismissed] = useState(false);
  // Anteprima "= +N ticket" della conversione: SEMPRE dal server (getConvertPreview →
  // ticket_preview, stessi tassi di convert_credit). Il client NON la calcola; null =
  // non ancora nota (nessun evento/anteprima disponibile) → la CTA la nasconde.
  const [convertPreview, setConvertPreview] = useState<number | null>(null);

  // ── Estrazione (G10) ───────────────────────────────────────────────────────
  // Esito del sorteggio, autoritativo dal server (my_draw_result). null = non ancora noto
  // (fase ESTRAZIONE → stato 'attesa'). Quando estratto===true si passa a win/lose.
  const [drawEstratto, setDrawEstratto] = useState(false);
  const [drawVinto, setDrawVinto] = useState(false);
  const [drawPremio, setDrawPremio] = useState<string | null>(null);

  // Snapshot ticket PRIMA di entrare in arena (per il delta) + ref al ticket LIVE, così
  // gli effetti leggono l'ultimo valore senza ri-sottoscriversi ad ogni cambio.
  const ticketPrimaRef = useRef<number | null>(null);
  const ticketLiveRef = useRef<number | null>(ticketTotali);
  ticketLiveRef.current = ticketTotali;

  // Sessioni GIÀ giocate: evita di rientrare nella stessa arena se, tornati all'hub, la
  // sessione risulta ancora attiva per qualche secondo (skew orologio client/server).
  const playedSessionsRef = useRef<Set<string>>(new Set());

  // secondi_rimasti ricalcolato dalla scadenza server (UX): clamp ≥ 0.
  const secondsLeftFromScadenza = useCallback((scadenza: string): number => {
    return Math.max(0, Math.ceil((new Date(scadenza).getTime() - Date.now()) / 1000));
  }, []);

  // (A) Polling della sessione di tap ATTIVA — SOLO in fase APERTA e SOLO fuori
  //     dall'arena/esito. Se compare una sessione: snapshot ticket, reset tap, entra.
  useEffect(() => {
    if (!guestId || !eventId) return;
    if (fase !== 'APERTA') return;
    if (view === 'tap' || view === 'esito') return;

    let active = true;
    const isActive = () => active;
    let timer: ReturnType<typeof setInterval> | null = null;

    const check = async () => {
      try {
        const s = await getActiveSession(supabaseRef.current!, { eventId });
        if (!isActive() || !s) return;
        if (playedSessionsRef.current.has(s.session_id)) return; // già giocata
        // Entra in arena: fissa lo snapshot ticket "prima", azzera i tap locali.
        ticketPrimaRef.current = ticketLiveRef.current ?? 0;
        setTapLocali(0);
        setSession({ sessionId: s.session_id, scadenza: s.scadenza });
        setSecondiRimasti(secondsLeftFromScadenza(s.scadenza));
        setView('tap');
      } catch {
        // Errore transitorio: ritenta al prossimo giro.
      }
    };

    void check();
    timer = setInterval(() => void check(), SESSION_POLL_MS);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [guestId, eventId, fase, view, secondsLeftFromScadenza]);

  // (B) Arena live: mentre view==='tap', ricalcola secondiRimasti dalla scadenza e
  //     verifica che la sessione sia ancora attiva. A scadenza (≤0) o sessione non più
  //     attiva → passa all'esito (flush finale dei tap gestito nell'effetto (C)).
  useEffect(() => {
    if (view !== 'tap' || !session || !eventId) return;
    let active = true;
    const isActive = () => active;

    const goEsito = () => {
      if (!isActive()) return;
      playedSessionsRef.current.add(session.sessionId);
      setEsitoTap(tapLocaliRef.current);
      setEsitoTicket(0);
      setEsitoPending(true);
      setView('esito');
      setSession(null);
    };

    // tick del countdown (server-derived) ~4/s per fluidità dell'anello.
    const tick = setInterval(() => {
      if (!isActive()) return;
      const left = secondsLeftFromScadenza(session.scadenza);
      setSecondiRimasti(left);
      if (left <= 0) goEsito();
    }, 250);

    // poll di conferma "sessione ancora attiva": se il regista chiude prima → esito.
    const poll = setInterval(async () => {
      try {
        const s = await getActiveSession(supabaseRef.current!, { eventId });
        if (!isActive()) return;
        if (!s || s.session_id !== session.sessionId) goEsito();
      } catch {
        // errore transitorio: il countdown locale resta il riferimento.
      }
    }, SESSION_POLL_MS);

    return () => {
      active = false;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [view, session, eventId, secondsLeftFromScadenza]);

  // (C) Flush CUMULATIVO dei tap durante l'arena (~1s) e all'uscita. registerTaps NON
  //     somma: inviamo il TOTALE locale corrente; il DB clampa/cappa (anti-cheat).
  useEffect(() => {
    if (view !== 'tap' || !session) return;
    const sessionId = session.sessionId;
    let lastSent = -1;

    const flush = async () => {
      const count = tapLocaliRef.current;
      if (count === lastSent) return; // niente di nuovo da inviare
      lastSent = count;
      try {
        await registerTaps(supabaseRef.current!, { sessionId, count });
      } catch {
        // errore transitorio: al prossimo giro reinviamo il cumulativo aggiornato.
        lastSent = -1;
      }
    };

    const timer = setInterval(() => void flush(), TAP_FLUSH_MS);
    return () => {
      clearInterval(timer);
      // flush finale col totale raggiunto (best-effort; il conteggio autoritativo è nel DB).
      void flush();
    };
  }, [view, session]);

  // (D) Esito: appena i ticket vengono assegnati (close_session del regista) il DELTA
  //     ticket_totali sale sopra lo snapshot "prima" → mostra i ticket guadagnati.
  //     Se entro CLOSE_WAIT_MS non arriva nulla, esce dal "pending" col delta noto (≥0).
  useEffect(() => {
    if (view !== 'esito' || !esitoPending) return;
    const prima = ticketPrimaRef.current ?? 0;
    let active = true;

    const resolveNow = () => {
      if (!active) return;
      const live = ticketLiveRef.current ?? prima;
      setEsitoTicket(Math.max(0, live - prima));
      setEsitoPending(false);
    };

    // se il delta è già positivo (ticket già assegnati) risolvi subito.
    const live0 = ticketLiveRef.current ?? prima;
    if (live0 > prima) {
      resolveNow();
      return;
    }

    // altrimenti attendi che ticketTotali (LIVE via useGuestState) risalga, poi risolvi.
    const poll = setInterval(() => {
      if (!active) return;
      const live = ticketLiveRef.current ?? prima;
      if (live > prima) resolveNow();
    }, 500);
    const timeout = setTimeout(() => {
      // timeout: mostra comunque l'esito col delta corrente (spesso 0 = nessun ticket).
      resolveNow();
    }, CLOSE_WAIT_MS);

    return () => {
      active = false;
      clearInterval(poll);
      clearTimeout(timeout);
    };
  }, [view, esitoPending, ticketTotali]);

  // ── Conversione (G9): convert_credit con idem STABILE ─────────────────────
  // Il DB verifica fase (LAST_CALL) e permesso (self-or-staff) + è idempotente su p_idem.
  // Dopo il successo: mostriamo "Convertito ✓" (i saldi→0 arrivano da useGuestState).
  const handleConverti = useCallback(async () => {
    if (!guestId || convertBusy) return;
    setConvertBusy(true);
    setConvertError(null);
    try {
      await convertCredit(supabaseRef.current!, {
        guestId,
        idem: stableConvertIdem(guestId),
      });
      setConverted(true);
    } catch (err) {
      const msg =
        err instanceof RpcError
          ? err.message
          : 'Conversione non riuscita. Riprova tra un istante.';
      setConvertError(msg);
    } finally {
      setConvertBusy(false);
    }
  }, [guestId, convertBusy]);

  // ── Conversione (G9): anteprima "= +N ticket" dal server ───────────────────
  // In fase LAST_CALL con credito residuo (>0) chiediamo a getConvertPreview il
  // ticket_preview (aggregato server-side con gli STESSI tassi di convert_credit): il
  // client NON lo calcola. Rifetch su cambio saldi (delta consumazioni post-registrazione)
  // e su cambio evento/fase. Fuori da LAST_CALL o senza credito azzeriamo l'anteprima.
  const saldoNormaleNum = saldoNormale ?? 0;
  const saldoPremiumNum = saldoPremium ?? 0;
  useEffect(() => {
    if (!eventId || fase !== 'LAST_CALL') {
      setConvertPreview(null);
      return;
    }
    if (saldoNormaleNum + saldoPremiumNum <= 0) {
      setConvertPreview(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const p = await getConvertPreview(supabaseRef.current!, { eventId });
        if (!active) return;
        setConvertPreview(p.ticket_preview);
      } catch {
        // Errore transitorio: l'anteprima resta nascosta (null); la conversione resta
        // possibile e i saldi/ticket restano server-authoritative via useGuestState.
        if (active) setConvertPreview(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [eventId, fase, saldoNormaleNum, saldoPremiumNum]);

  // ── Estrazione (G10): poll dell'esito guest-safe finché estratto===true ────
  // Attivo in fase ESTRAZIONE e CHIUSA (se l'estrazione è già avvenuta l'esito è finale).
  // my_draw_result NON espone dati di altri ospiti: ritorna SOLO l'esito del chiamante.
  useEffect(() => {
    if (!guestId || !eventId) return;
    if (fase !== 'ESTRAZIONE' && fase !== 'CHIUSA') return;
    if (drawEstratto) return; // esito già rivelato: niente altro polling

    let active = true;
    const isActive = () => active;
    let timer: ReturnType<typeof setInterval> | null = null;

    const check = async () => {
      try {
        const res = await getMyDrawResult(supabaseRef.current!, { eventId });
        if (!isActive()) return;
        if (res.estratto) {
          setDrawVinto(res.vinto);
          setDrawPremio(res.premio);
          setDrawEstratto(true); // → l'effetto si smonta (dep drawEstratto)
        }
      } catch {
        // errore transitorio: resta in 'attesa', ritenta al prossimo giro.
      }
    };

    void check();
    timer = setInterval(() => void check(), DRAW_POLL_MS);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [guestId, eventId, fase, drawEstratto]);

  const seed = guestId ? seedFromId(guestId) : 7;
  const dash = (v: number | null) => (v == null ? '—' : v);

  // Bar chiuso se la fase NON è APERTA (né SETUP): avviso + voci attenuate nel menù.
  const barChiuso = fase != null && fase !== 'APERTA' && fase !== 'SETUP';
  const menuNotice = fase ? PHASE_NOTICE[fase] ?? null : null;

  // DrinkRow → MenuItem (sola lettura, nessun ricalcolo). Riferimento eventId per chiarezza.
  void eventId;
  const menuItems: MenuItem[] = drinks.map((d, i) => toMenuItem(d, i));

  // Arena tap (G7): immersivo full-screen, ha priorità (auto-entrato dalla regia).
  if (view === 'tap') {
    return (
      <TapArena
        secondiRimasti={secondiRimasti}
        tapLocali={tapLocali}
        onTap={() => setTapLocali((n) => n + 1)}
        level={6}
        seed={seed}
      />
    );
  }
  // Esito tap (G8): ticket guadagnati = delta ticket_totali dopo close_session.
  if (view === 'esito') {
    return (
      <EsitoTap
        ticketGuadagnati={esitoTicket}
        tapTotali={esitoTap}
        pending={esitoPending}
        seed={seed}
        onDone={() => setView('totem')}
      />
    );
  }

  if (showQR) {
    return (
      <GuestQR
        name={nome ?? ''}
        pin={pin ?? '----'}
        guestId={guestId ?? ''}
        onBack={() => setShowQR(false)}
      />
    );
  }

  // ── Estrazione (G10): fase ESTRAZIONE, oppure CHIUSA con estrazione già avvenuta ──
  // Vista immersiva (attesa → win/lose). L'esito è SERVER-authoritative (my_draw_result):
  //   • estratto=false → 'attesa' (totem pulsa, "estrazione in corso").
  //   • estratto=true  → 'win' se vinto, altrimenti 'lose'.
  // In CHIUSA la mostriamo SOLO se l'estrazione è già avvenuta (drawEstratto): se in CHIUSA
  // non c'è alcun sorteggio, cadiamo sull'hub (stato finale col banner PHASE_NOTICE).
  const revealTicket = ticketTotali ?? 0;
  if (fase === 'ESTRAZIONE' || (fase === 'CHIUSA' && drawEstratto)) {
    return (
      <Reveal
        stato={drawEstratto ? (drawVinto ? 'win' : 'lose') : 'attesa'}
        ticket={revealTicket}
        premio={drawPremio}
      />
    );
  }

  // ── Conversione (G9): fase LAST_CALL con credito residuo (>0) ──────────────
  // Vista full-screen (G9 + modale G9b). Saldi/anteprima dal server; l'esito post-conversione
  // ("Convertito ✓") e i saldi→0 sono server-authoritative (useGuestState). "Non ora" posticipa
  // (convertDismissed) lasciando navigare l'hub; l'ospite può tornarci finché resta LAST_CALL.
  const saldoResiduo = (saldoNormale ?? 0) + (saldoPremium ?? 0);
  if (fase === 'LAST_CALL' && (converted || (saldoResiduo > 0 && !convertDismissed))) {
    return (
      <Conversione
        saldoNormale={saldoNormale ?? 0}
        saldoPremium={saldoPremium ?? 0}
        anteprimaTicket={convertPreview}
        busy={convertBusy}
        error={convertError}
        done={converted}
        onConferma={handleConverti}
        onAnnulla={() => setConvertDismissed(true)}
        seed={seed}
      />
    );
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
    // Righe REALI dell'ospite (RLS tx_select) → type presentazionale, senza sommare nulla.
    // Vuoto: GuestMovimenti rende già l'empty-state (nessuna riga = "Ancora nessun movimento").
    const tx: Tx[] = txRows.map(toTx);
    return (
      <GuestMovimenti
        ticket={dash(ticketTotali)}
        consumazioni={`${saldoNormale ?? 0}N · ${saldoPremium ?? 0}P`}
        tx={tx}
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
