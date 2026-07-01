// Schermata REGIA (spec §10, R1–R8) — DESIGN Claude (sidebar + shell dark, palette
// africana calda) CABLATO alla logica M2 già esistente. Le viste sono TAB nella sidebar.
//
// Il front-end NON calcola MAI: fase e statistiche (presenze / gettoni venduti /
// ticket totali) arrivano dal server via getEventStats. I controlli mutano stato solo
// via wrapper RPC (@/lib/regia). Realtime via EventSource; fallback polling.
//
// FLUSSO (invariato da M2):
//   1) Gate ruolo: getSessionRole → isStaffRole (regia|admin). cassa NON basta.
//   2) eventId via getCurrentEventId.
//   3) READ-ONLY: getEventStats → { fase, presenze, gettoni_venduti, ticket_totali }.
//      currentPhase deriva da stats.fase (mai dedotta dal client).
//   4) LIVE: EventSource('/api/stream/regia') evento 'phase' + refetch; SSE '/drinks'
//      per il menù. Fallback polling ~3s se !USE_API o EventSource non disponibile.
//   5) CONTROLLI: setPhase, startSession(30), runDraw(3), CRUD drink. Dopo ogni
//      mutazione → refetch. Nessun calcolo lato client.
//
// La logica è identica a prima: cambia SOLO la presentazione (shell/sidebar/tab).
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  RegiaShell,
  RegiaDashboard,
  type RegiaTab,
  type Kpi,
} from '@/components/screens/Regia';
import Totem from '@/components/Totem';
import { createClient } from '@/lib/supabase/client';
import { getCurrentEventId } from '@/lib/events';
import { USE_API } from '@/lib/backend-mode';
import {
  getSessionRole,
  isStaffRole,
  staffSignIn,
  signOut,
} from '@/lib/auth';
import {
  getEventStats,
  listAllDrinks,
  getActiveSession,
  getLedger,
  RpcError,
  type EventStats,
  type DrinkRow,
  type TipoConsumazione,
  type Ledger,
  type LedgerRow,
} from '@/lib/rpc';
import {
  setPhase,
  startSession,
  closeSession,
  runDraw,
  updateEventSettings,
  upsertDrink,
  deleteDrink,
  setDrinkVisibility,
  setDrinkActive,
  getLeaderboard,
  getLastDraw,
  getGuestsList,
  type Phase,
  type LeaderboardRow,
  type LastDraw,
  type GuestListRow,
} from '@/lib/regia';

// Fasi del flusso serata (spec §10). Ordine/labels per timeline e controlli; la fase
// REALE arriva da stats.fase (server-authoritative), mai dedotta dal client.
const PHASES: Phase[] = ['SETUP', 'APERTA', 'LAST_CALL', 'ESTRAZIONE', 'CHIUSA'];

const PHASE_LABEL: Record<Phase, string> = {
  SETUP: 'Setup',
  APERTA: 'Aperta',
  LAST_CALL: 'Last call',
  ESTRAZIONE: 'Estrazione',
  CHIUSA: 'Chiusa',
};

// Titolo topbar per tab (coincide con l'header display della shell del mockup).
const TAB_TITLE: Record<RegiaTab, string> = {
  dashboard: 'DASHBOARD',
  fasi: 'CONTROLLO FASI',
  sessioni: 'SESSIONI TAP',
  menu: 'GESTIONE MENÙ',
  impostazioni: 'IMPOSTAZIONI EVENTO',
  estrazione: 'ESTRAZIONE',
  ledger: 'LEDGER',
  ospiti: 'OSPITI',
};

// Intervallo polling di FALLBACK (path supabase o EventSource non disponibile): rilegge
// le stats ogni ~3s. In modalità API+SSE NON si fa polling: push via stream.
const POLL_MS = 3000;

// Intervallo polling della CLASSIFICA LIVE (tab sessioni, R3): ~2s. La leaderboard è
// pura lettura (getLeaderboard), i tap_count arrivano CUMULATIVI dal DB; il client non
// somma nulla. Anche la finestra della sessione attiva (getActiveSession) si rilegge qui.
const LEADERBOARD_POLL_MS = 2000;

// ── Palette design (mockup Regia) ─────────────────────────────────────────────
// Coerente con components/screens/Regia.tsx (sfondo #190F08, superficie #2A1A11,
// bordo #43291A, oro #D89A3E, blu #3A5BBE, testo caldo). Niente token globals qui
// perché il mockup usa questi hex diretti: li riuso per coerenza 1:1 con la shell.
const C = {
  surface: '#2A1A11',
  border: '#43291A',
  gold: '#D89A3E',
  goldSoft: '#E7C98C',
  blue: '#3A5BBE',
  ink: '#fff',
  inkSoft: '#D8C3A6',
  inkMuted: '#A58A66',
  green: '#2BA35A',
  danger: '#E06A4A',
} as const;

const panel: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 16,
  padding: 22,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '11px 13px',
  borderRadius: 10,
  fontSize: 15,
  color: C.ink,
  background: '#190F08',
  border: `1px solid ${C.border}`,
  outlineColor: C.blue,
  fontFamily: 'var(--font-ui)',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 7,
  fontFamily: 'var(--font-ritual)',
  letterSpacing: '.14em',
  fontSize: 11,
  color: C.inkMuted,
  textTransform: 'uppercase',
};

// Bottone "design" inline (il mockup non esporta un Button: replico lo stile shell).
function DButton({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
  full,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'gold' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  full?: boolean;
}) {
  const base: React.CSSProperties = {
    padding: '11px 18px',
    borderRadius: 10,
    fontSize: 14.5,
    fontWeight: 600,
    fontFamily: 'var(--font-ui)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    width: full ? '100%' : undefined,
    transition: 'filter .15s ease',
    border: '1px solid transparent',
  };
  const skins: Record<string, React.CSSProperties> = {
    primary: { background: C.blue, color: '#fff' },
    gold: { background: C.gold, color: '#190F08' },
    ghost: { background: 'transparent', color: C.inkSoft, borderColor: C.border },
    danger: { background: 'transparent', color: C.danger, borderColor: 'rgba(224,106,74,.5)' },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{ ...base, ...skins[variant] }}>
      {children}
    </button>
  );
}

// Feedback/errore riga uniforme (verde/oro = ok, rosso = errore).
function Note({ kind, children }: { kind: 'ok' | 'err'; children: React.ReactNode }) {
  return (
    <p style={{ margin: '2px 0 0', fontSize: 13.5, color: kind === 'ok' ? C.gold : C.danger }}>
      {children}
    </p>
  );
}

// Colore posizione classifica (R3): oro → argento → bronzo per il podio, poi tenue.
// Solo presentazionale, il ranking arriva già ordinato dal server (tap_count desc).
const EMBER = '#EE6321'; // ambra del mockup (barra viola→ambra, countdown)
function rankColor(pos: number): string {
  if (pos === 1) return C.gold;
  if (pos === 2) return C.goldSoft;
  if (pos === 3) return EMBER;
  return C.inkMuted;
}

// Chip del tipo transazione nel ledger (R7): solo presentazionale (border+color per tipo).
// Il tipo è già validato lato DB (check ('ricarica','consumo','conversione','tap')).
const LEDGER_TIPO_CHIP: Record<LedgerRow['tipo'], { color: string; border: string }> = {
  ricarica: { color: C.green, border: 'rgba(43,163,90,.5)' },
  consumo: { color: EMBER, border: 'rgba(238,99,33,.5)' },
  conversione: { color: C.blue, border: 'rgba(58,91,190,.6)' },
  tap: { color: C.gold, border: 'rgba(216,154,62,.5)' },
};

// Formattazione EURO/interi con cifre "contabili" (it-IT). Solo presentazione: i VALORI
// arrivano già dal server, qui non si somma né si arrotonda nulla di dominio.
function fmtEuro(n: number): string {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n);
}
function fmtInt(n: number): string {
  return new Intl.NumberFormat('it-IT').format(n);
}

// Δ con segno esplicito (i delta positivi mostrano il +) — presentazionale.
function fmtDelta(n: number): string {
  if (n === 0) return '0';
  const s = fmtInt(Math.abs(n));
  return n > 0 ? `+${s}` : `−${s}`;
}

// Escape di un campo per CSV (RFC4180-ish): virgolette raddoppiate + quoting se serve.
function csvCell(v: string | number | null): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Export CSV client-side delle righe GIÀ ricevute dal server (NON è ricalcolo di dominio:
// è la serializzazione dei dati del ledger che il DB ha già prodotto). Trigger download via
// blob + anchor temporaneo, poi revoke dell'URL. Nessuna dipendenza esterna.
function exportLedgerCsv(righe: LedgerRow[], nameByGuest: Map<string, string>): void {
  const header = [
    'Ora',
    'Tipo',
    'Tipo consumazione',
    'Ospite',
    'Guest ID',
    'Operatore',
    'Δ gettoni',
    'Δ ticket',
    'Importo €',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of righe) {
    lines.push(
      [
        new Date(r.created_at).toISOString(),
        r.tipo,
        r.tipo_consumazione ?? '',
        nameByGuest.get(r.guest_id) ?? '',
        r.guest_id,
        r.operatore ?? '',
        r.qta_delta,
        r.ticket_delta,
        r.importo_euro ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // BOM per Excel + CRLF (compatibilità fogli di calcolo).
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Anello countdown (R3): Anton al centro, arco ambra che si svuota man mano che i secondi
// scendono. `secondi` è UX (dalla scadenza server): non è un dato autoritativo di tap/ticket.
function CountdownRing({ secondi, durataTotale }: { secondi: number; durataTotale: number }) {
  const R = 44;
  const CIRC = 2 * Math.PI * R; // ~276
  const frac = durataTotale > 0 ? Math.max(0, Math.min(1, secondi / durataTotale)) : 0;
  const offset = CIRC * (1 - frac); // pieno a inizio, vuoto a 0s
  return (
    <div style={{ position: 'relative', width: 78, height: 78, flexShrink: 0 }}>
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
        <circle cx="50" cy="50" r={R} fill="none" stroke="#3A2414" strokeWidth="8" />
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke={EMBER}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          style={{ filter: `drop-shadow(0 0 6px ${EMBER})`, transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-display)',
          fontSize: 24,
        }}
      >
        {secondi}
      </div>
    </div>
  );
}

export default function RegiaPage() {
  // Istanza supabase singola e stabile per tutta la vita della pagina.
  const supabase = useMemo(() => createClient(), []);

  // ── Tab attivo (sidebar) ────────────────────────────────────────────────
  const [tab, setTab] = useState<RegiaTab>('dashboard');

  // ── Fase A — gate ruolo ────────────────────────────────────────────────
  const [role, setRole] = useState<string | null>(null);
  const [roleChecked, setRoleChecked] = useState(false);

  // ── Fase B — form login staff ──────────────────────────────────────────
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // ── Evento corrente ─────────────────────────────────────────────────────
  const [eventId, setEventId] = useState<string | null>(null);
  const [eventChecked, setEventChecked] = useState(false);

  // ── Stato READ-ONLY (dal server, mai calcolato) ─────────────────────────
  const [stats, setStats] = useState<EventStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  // ── Controlli (muta-stato) ──────────────────────────────────────────────
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // ── Estrazione (R6) ─────────────────────────────────────────────────────
  // nWinners: numero vincitori da estrarre (stepper, default 3). SOLO input UI.
  // lastDraw: ultima estrazione REGISTRATA lato server (getLastDraw) → alimenta il
  //   reveal stage (R6b). I vincitori NON sono mai inventati dal client: vengono da qui.
  const [nWinners, setNWinners] = useState(3);
  const [lastDraw, setLastDraw] = useState<LastDraw | null>(null);
  const [lastDrawChecked, setLastDrawChecked] = useState(false);
  const [lastDrawError, setLastDrawError] = useState<string | null>(null);

  // ── Sessioni tap (R3) — stato LIVE/IDLE, tutto SOLA LETTURA dal server ───
  // activeSession: finestra della sessione attiva (getActiveSession) o null (IDLE).
  // leaderboard: classifica tap live (getLeaderboard), tap_count CUMULATIVO dal DB.
  // secondsLeft: countdown UX ricavato dalla scadenza (non autoritativo).
  const [activeSession, setActiveSession] = useState<{
    session_id: string;
    scadenza: string;
    secondi_rimasti: number;
  } | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // ── Impostazioni evento (form minimale, campi opzionali) ────────────────
  const [setNormale, setSetNormale] = useState('');
  const [setPremium, setSetPremium] = useState('');
  const [setDurata, setSetDurata] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsFeedback, setSettingsFeedback] = useState<string | null>(null);

  // ── Gestione menù (CRUD listino) ────────────────────────────────────────
  const [drinks, setDrinks] = useState<DrinkRow[]>([]);
  const [drinksError, setDrinksError] = useState<string | null>(null);
  const [menuBusy, setMenuBusy] = useState<string | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [menuFeedback, setMenuFeedback] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formNome, setFormNome] = useState('');
  const [formTipo, setFormTipo] = useState<TipoConsumazione>('normale');
  const [formDescrizione, setFormDescrizione] = useState('');
  const [formCategoria, setFormCategoria] = useState('');
  const [formOrdine, setFormOrdine] = useState('0');

  // ── R7 — Ledger / riconciliazione (SOLA LETTURA) ────────────────────────
  // ledger.totali arriva AGGREGATO dal server (incasso/gettoni/ticket): il client NON
  // ricalcola i totali, li mostra e basta. ledger.righe = ultime ~100 tx (created_at desc).
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerChecked, setLedgerChecked] = useState(false);
  const [ledgerBusy, setLedgerBusy] = useState(false);

  // ── R8 — Ospiti (lista + drawer, SOLA LETTURA) ──────────────────────────
  // guests = lista ospiti dal server (saldi/ticket/livello autoritativi dal DB). guestSearch
  // è SOLO un filtro presentazionale (nome/PIN). selectedGuest = riga aperta nel drawer.
  const [guests, setGuests] = useState<GuestListRow[]>([]);
  const [guestsError, setGuestsError] = useState<string | null>(null);
  const [guestsChecked, setGuestsChecked] = useState(false);
  const [guestSearch, setGuestSearch] = useState('');
  const [selectedGuest, setSelectedGuest] = useState<GuestListRow | null>(null);

  const staff = isStaffRole(role) && (role === 'regia' || role === 'admin');

  // ── Derivati R7/R8 (memoizzati). Devono stare qui, PRIMA di ogni early return ──
  // (le regole degli hook vietano useMemo condizionale). Sono pure viste presentazionali
  // dei dati già ricevuti dal server: nessun ricalcolo di dominio (saldi/ticket/totali).
  //
  // Mappa guest_id → nome dalla lista ospiti (R8), riusata dal ledger (R7) per la colonna
  // "Ospite" e dal CSV (le righe tx portano solo il guest_id).
  const guestNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of guests) m.set(g.id, g.nome);
    return m;
  }, [guests]);

  // Filtro presentazionale della lista ospiti (R8): match su nome o PIN, case-insensitive.
  // SOLO filtro di presentazione — non tocca saldi/ticket/ordinamento (già dal server).
  const filteredGuests = useMemo(() => {
    const q = guestSearch.trim().toLowerCase();
    if (!q) return guests;
    return guests.filter(
      (g) => g.nome.toLowerCase().includes(q) || g.pin.toLowerCase().includes(q),
    );
  }, [guests, guestSearch]);

  // Timeline tx dell'ospite selezionato (R8 drawer): righe del ledger già ricevute, filtrate
  // per guest_id. È SOLO una vista delle tx prodotte dal server (nessun ricalcolo). Disponibile
  // se il ledger è stato caricato (tab Ledger visitato in questa sessione).
  const selectedGuestTimeline = useMemo(() => {
    if (!selectedGuest || !ledger) return [];
    return ledger.righe.filter((r) => r.guest_id === selectedGuest.id);
  }, [selectedGuest, ledger]);

  // Ref alla funzione di fetch stats per usarla dentro lo stream/polling senza
  // ricreare l'effetto ad ogni render (eventId è la sola dipendenza che conta).
  const eventIdRef = useRef<string | null>(null);
  eventIdRef.current = eventId;

  // Fetch autoritativo delle stats. SOLA LETTURA: setta i 4 valori dal server,
  // currentPhase deriva da stats.fase. Nessuna somma/derivazione lato client.
  async function refetchStats() {
    const id = eventIdRef.current;
    if (!id) return;
    try {
      const s = await getEventStats(supabase, { eventId: id });
      setStats(s);
      setStatsError(null);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Statistiche non disponibili');
    }
  }

  // Fetch autoritativo del listino COMPLETO (anche non visibili/non attivi). SOLA
  // LETTURA: la lista arriva dal server, qui non si filtra né ordina.
  async function refetchDrinks() {
    const id = eventIdRef.current;
    if (!id) return;
    try {
      const rows = await listAllDrinks(supabase, { eventId: id });
      setDrinks(rows);
      setDrinksError(null);
    } catch (err) {
      setDrinksError(err instanceof Error ? err.message : 'Listino non disponibile');
    }
  }

  // Ref alla sessione attiva corrente, per leggere la leaderboard nel polling senza
  // rilegare l'effetto ad ogni cambio scadenza (l'id è la sola cosa che conta).
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSession?.session_id ?? null;

  // Fetch SOLA LETTURA della sessione attiva (R3): finestra temporale dell'arena o null.
  // secondi_rimasti è UX (dal server nel path API, derivato nel path supabase) — non
  // ricalcoliamo tap/ticket. Se scompare (chiusa/scaduta) svuotiamo anche la classifica.
  async function refetchActiveSession() {
    const id = eventIdRef.current;
    if (!id) return;
    try {
      const s = await getActiveSession(supabase, { eventId: id });
      setActiveSession(s);
      setSecondsLeft(s ? s.secondi_rimasti : null);
      if (!s) setLeaderboard([]);
      setSessionError(null);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Sessione non disponibile');
    } finally {
      setSessionChecked(true);
    }
  }

  // Fetch SOLA LETTURA della classifica tap live della sessione attiva. tap_count è il
  // totale CUMULATIVO dal DB (register_taps clamp/cap): qui NON si somma nulla, si ordina
  // e si mostra. Riordino live perché la lista arriva già ordinata tap_count desc.
  async function refetchLeaderboard() {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    try {
      const rows = await getLeaderboard(supabase, { sessionId: sid });
      setLeaderboard(rows);
      setSessionError(null);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Classifica non disponibile');
    }
  }

  // Fetch SOLA LETTURA dell'ultima estrazione registrata (R6): winners/seed/n_winners.
  // NIENTE ricalcolo: `winners` è già la classifica finale prodotta da run_draw; qui la
  // si legge e basta per popolare il reveal stage. null → nessuna estrazione ancora fatta.
  async function refetchLastDraw() {
    const id = eventIdRef.current;
    if (!id) return;
    try {
      const d = await getLastDraw(supabase, { eventId: id });
      setLastDraw(d);
      setLastDrawError(null);
    } catch (err) {
      setLastDrawError(err instanceof Error ? err.message : 'Estrazione non disponibile');
    } finally {
      setLastDrawChecked(true);
    }
  }

  // Fetch SOLA LETTURA del ledger (R7): totali AGGREGATI dal server + ultime ~100 righe tx.
  // NIENTE ricalcolo: i totali (incasso/gettoni/ticket emessi) arrivano già sommati dal DB;
  // qui non si somma nulla, si mostra. Le righe sono append-only (created_at desc).
  async function refetchLedger() {
    const id = eventIdRef.current;
    if (!id) return;
    setLedgerBusy(true);
    try {
      const l = await getLedger(supabase, { eventId: id });
      setLedger(l);
      setLedgerError(null);
    } catch (err) {
      setLedgerError(err instanceof Error ? err.message : 'Ledger non disponibile');
    } finally {
      setLedgerBusy(false);
      setLedgerChecked(true);
    }
  }

  // Fetch SOLA LETTURA della lista ospiti (R8): saldi/ticket/livello autoritativi dal DB.
  // Il client NON ricalcola nulla (ticket_totali è GENERATED lato DB); la ricerca è un mero
  // filtro presentazionale applicato più sotto. La lista arriva già ordinata per nome.
  async function refetchGuests() {
    const id = eventIdRef.current;
    if (!id) return;
    try {
      const rows = await getGuestsList(supabase, { eventId: id });
      setGuests(rows);
      setGuestsError(null);
    } catch (err) {
      setGuestsError(err instanceof Error ? err.message : 'Ospiti non disponibili');
    } finally {
      setGuestsChecked(true);
    }
  }

  // ── Gate iniziale: ruolo della sessione (se esiste) al mount. ───────────
  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await getSessionRole(supabase);
      if (!active) return;
      setRole(r);
      setRoleChecked(true);
    })();
    return () => {
      active = false;
    };
  }, [supabase]);

  // ── Risolvi l'evento corrente quando si è staff autorizzato. ────────────
  useEffect(() => {
    if (!staff) {
      setEventId(null);
      setEventChecked(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const id = await getCurrentEventId(supabase);
        if (!active) return;
        setEventId(id);
      } catch {
        if (!active) return;
        setEventId(null);
      } finally {
        if (active) setEventChecked(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [supabase, staff]);

  // ── READ-ONLY + LIVE: fetch iniziale, poi stream SSE (USE_API) o polling. ─
  useEffect(() => {
    if (!staff || !eventId) return;
    let active = true;

    void refetchStats();

    if (USE_API && typeof EventSource !== 'undefined') {
      let es: EventSource | null = null;
      try {
        es = new EventSource('/api/stream/regia?event=' + encodeURIComponent(eventId), {
          withCredentials: true,
        });
      } catch {
        es = null;
      }

      if (es) {
        const onPhase = (ev: MessageEvent) => {
          if (!active) return;
          try {
            const data = JSON.parse(ev.data) as { fase?: string };
            if (data && typeof data.fase === 'string') {
              setStats((prev) => (prev ? { ...prev, fase: data.fase as string } : prev));
            }
          } catch {
            // payload non-JSON / vuoto: ignora, il refetch riallinea comunque.
          }
          void refetchStats();
        };
        es.onopen = () => {
          if (!active) return;
          void refetchStats();
        };
        es.addEventListener('phase', onPhase as EventListener);
        return () => {
          active = false;
          es?.removeEventListener('phase', onPhase as EventListener);
          es?.close();
        };
      }
    }

    const timer = setInterval(() => {
      if (!active) return;
      void refetchStats();
    }, POLL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, eventId]);

  // ── Gestione menù: fetch iniziale del listino + LIVE via SSE drinks. ──────
  useEffect(() => {
    if (!staff || !eventId) return;
    let active = true;

    void refetchDrinks();

    if (USE_API && typeof EventSource !== 'undefined') {
      let es: EventSource | null = null;
      try {
        es = new EventSource('/api/stream/drinks?event=' + encodeURIComponent(eventId), {
          withCredentials: true,
        });
      } catch {
        es = null;
      }

      if (es) {
        const onDrinks = () => {
          if (!active) return;
          void refetchDrinks();
        };
        es.onopen = () => {
          if (!active) return;
          void refetchDrinks();
        };
        es.addEventListener('drinks', onDrinks as EventListener);
        return () => {
          active = false;
          es?.removeEventListener('drinks', onDrinks as EventListener);
          es?.close();
        };
      }
    }

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, eventId]);

  // ── Sessioni tap (R3): polling ~2s di sessione attiva + classifica live. ──
  // Attivo SOLO quando il tab 'sessioni' è aperto (niente polling di fondo altrove).
  // Tutto SOLA LETTURA: getActiveSession (finestra) + getLeaderboard (tap CUMULATIVI dal DB).
  useEffect(() => {
    if (!staff || !eventId || tab !== 'sessioni') return;
    let active = true;

    // Primo giro: prima la sessione (per avere l'id), poi la classifica se c'è.
    void (async () => {
      await refetchActiveSession();
      if (active) await refetchLeaderboard();
    })();

    const timer = setInterval(() => {
      if (!active) return;
      void (async () => {
        await refetchActiveSession();
        if (active) await refetchLeaderboard();
      })();
    }, LEADERBOARD_POLL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, eventId, tab]);

  // ── Estrazione (R6): al primo ingresso nel tab legge l'ultima estrazione ──
  // registrata (se già avvenuta → mostra il reveal). SOLA LETTURA, nessun polling:
  // l'estrazione è un evento raro/manuale, si rilegge solo entrando nel tab e dopo runDraw.
  useEffect(() => {
    if (!staff || !eventId || tab !== 'estrazione') return;
    let active = true;
    void (async () => {
      if (!active) return;
      await refetchLastDraw();
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, eventId, tab]);

  // ── Ledger (R7): al primo ingresso nel tab legge totali+righe. SOLA LETTURA, ──
  // nessun polling (il ledger si ispeziona a fine serata/spot); refresh manuale disponibile.
  useEffect(() => {
    if (!staff || !eventId || tab !== 'ledger') return;
    let active = true;
    void (async () => {
      if (!active) return;
      await refetchLedger();
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, eventId, tab]);

  // ── Ospiti (R8): al primo ingresso nel tab legge la lista ospiti. SOLA LETTURA, ──
  // nessun polling; refresh manuale disponibile. La ricerca è client-side (presentazionale).
  useEffect(() => {
    if (!staff || !eventId || tab !== 'ospiti') return;
    let active = true;
    void (async () => {
      if (!active) return;
      await refetchGuests();
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, eventId, tab]);

  // Countdown UX locale: scala secondsLeft ogni secondo tra un poll e l'altro (il valore
  // autoritativo resta la scadenza dal server, ri-sincronizzata ad ogni refetchActiveSession).
  useEffect(() => {
    if (secondsLeft === null || secondsLeft <= 0) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => (s === null ? null : Math.max(0, s - 1)));
    }, 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await staffSignIn(supabase, email, password);
      const r = await getSessionRole(supabase);
      if (isStaffRole(r) && (r === 'regia' || r === 'admin')) {
        setRole(r);
        setPassword('');
      } else {
        await signOut(supabase);
        setRole(null);
        setAuthError('Account senza permessi regia');
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Credenziali non valide');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleEsci() {
    await signOut(supabase);
    setRole(null);
    setEventId(null);
    setEventChecked(false);
    setStats(null);
    setStatsError(null);
    setActionError(null);
    setFeedback(null);
    setNWinners(3);
    setLastDraw(null);
    setLastDrawChecked(false);
    setLastDrawError(null);
    setActiveSession(null);
    setSessionChecked(false);
    setSessionError(null);
    setLeaderboard([]);
    setSecondsLeft(null);
    setDrinks([]);
    setDrinksError(null);
    setMenuError(null);
    setMenuFeedback(null);
    setLedger(null);
    setLedgerError(null);
    setLedgerChecked(false);
    setGuests([]);
    setGuestsError(null);
    setGuestsChecked(false);
    setGuestSearch('');
    setSelectedGuest(null);
    resetMenuForm();
    setEmail('');
    setPassword('');
  }

  // Esegue una mutazione di dominio (key = id azione per il busy puntuale), poi
  // RIFETCH le stats. NESSUN calcolo client: la fase/le stat tornano dal server.
  async function runAction(key: string, fn: () => Promise<unknown>, ok: string) {
    if (!eventId) return;
    setBusyAction(key);
    setActionError(null);
    setFeedback(null);
    try {
      await fn();
      setFeedback(ok);
      await refetchStats();
    } catch (err) {
      if (err instanceof RpcError) {
        setActionError(err.message);
      } else {
        setActionError(err instanceof Error ? err.message : 'Operazione fallita');
      }
    } finally {
      setBusyAction(null);
    }
  }

  function handleSetPhase(phase: Phase) {
    void runAction(
      'phase:' + phase,
      () => setPhase(supabase, { eventId: eventId as string, phase }),
      'Fase impostata: ' + PHASE_LABEL[phase],
    );
  }

  function handleStartSession() {
    void runAction(
      'session',
      async () => {
        const res = await startSession(supabase, { eventId: eventId as string, durata: 30 });
        // Transizione IDLE→LIVE immediata: rilegge la sessione attiva (e azzera la
        // classifica precedente) senza attendere il prossimo giro di polling.
        await refetchActiveSession();
        return res;
      },
      'Sessione 30s lanciata',
    );
  }

  // Chiude la sessione attiva (regia): close_session assegna i ticket_tap lato DB e
  // ritorna il totale ticket. Qui NON ricalcoliamo nulla: dopo la chiusura rilegge la
  // sessione (→ null, stato IDLE) e le stats (ticket_totali aggiornati dal server).
  function handleCloseSession() {
    const sid = activeSession?.session_id;
    if (!sid) return;
    void runAction(
      'session-close',
      async () => {
        const ticket = await closeSession(supabase, { sessionId: sid });
        setActiveSession(null);
        setSecondsLeft(null);
        setLeaderboard([]);
        await refetchActiveSession();
        return ticket;
      },
      'Sessione chiusa · ticket assegnati',
    );
  }

  function handleDraw() {
    // Clamp difensivo del numero vincitori (min 1): il server è comunque autoritativo.
    const n = Math.max(1, Math.trunc(nWinners) || 1);
    void runAction(
      'draw',
      async () => {
        // L'estrazione vive in fase ESTRAZIONE: se non ci siamo, portiamoci prima.
        if (stats && stats.fase !== 'ESTRAZIONE') {
          await setPhase(supabase, { eventId: eventId as string, phase: 'ESTRAZIONE' });
        }
        const res = await runDraw(supabase, { eventId: eventId as string, nWinners: n });
        // Reveal stage (R6b): i vincitori arrivano dal server via getLastDraw, MAI dal client.
        // Rileggiamo subito l'estrazione appena registrata senza attendere un refetch di tab.
        await refetchLastDraw();
        return res;
      },
      'Estrazione eseguita',
    );
  }

  // ── Impostazioni evento (R5) — form minimale sui campi principali. ────────
  // Campi vuoti = "non toccare" (il wrapper mappa a null → il DB fa coalesce).
  function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!eventId) return;
    setSettingsBusy(true);
    setSettingsError(null);
    setSettingsFeedback(null);
    const num = (s: string): number | null => {
      const t = s.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };
    void (async () => {
      try {
        await updateEventSettings(supabase, {
          eventId: eventId as string,
          prezzoNormale: num(setNormale),
          prezzoPremium: num(setPremium),
          durataSessioneS: num(setDurata),
        });
        setSettingsFeedback('Impostazioni salvate');
      } catch (err) {
        if (err instanceof RpcError) setSettingsError(err.message);
        else setSettingsError(err instanceof Error ? err.message : 'Salvataggio fallito');
      } finally {
        setSettingsBusy(false);
      }
    })();
  }

  // ── Handlers gestione menù ───────────────────────────────────────────────

  async function runMenuAction(
    key: string,
    fn: () => Promise<unknown>,
    ok: string,
  ): Promise<boolean> {
    if (!eventId) return false;
    setMenuBusy(key);
    setMenuError(null);
    setMenuFeedback(null);
    try {
      await fn();
      setMenuFeedback(ok);
      await refetchDrinks();
      return true;
    } catch (err) {
      if (err instanceof RpcError) {
        setMenuError(err.message);
      } else {
        setMenuError(err instanceof Error ? err.message : 'Operazione fallita');
      }
      return false;
    } finally {
      setMenuBusy(null);
    }
  }

  function resetMenuForm() {
    setEditingId(null);
    setFormNome('');
    setFormTipo('normale');
    setFormDescrizione('');
    setFormCategoria('');
    setFormOrdine('0');
  }

  function handleEditDrink(d: DrinkRow) {
    setEditingId(d.id);
    setFormNome(d.nome);
    setFormTipo(d.tipo);
    setFormDescrizione(d.descrizione ?? '');
    setFormCategoria(d.categoria ?? '');
    setFormOrdine(String(d.ordine));
    setMenuError(null);
    setMenuFeedback(null);
  }

  function handleSubmitDrink(e: React.FormEvent) {
    e.preventDefault();
    const nome = formNome.trim();
    if (!nome) {
      setMenuError('Il nome è obbligatorio');
      return;
    }
    const ordineParsed = Number.parseInt(formOrdine, 10);
    const ordine = Number.isFinite(ordineParsed) ? ordineParsed : 0;
    const id = editingId;
    void runMenuAction(
      id ? 'edit:' + id : 'create',
      () =>
        upsertDrink(supabase, {
          eventId: eventId as string,
          id,
          nome,
          tipo: formTipo,
          descrizione: formDescrizione.trim() || null,
          categoria: formCategoria.trim() || null,
          ordine,
        }),
      id ? 'Voce aggiornata' : 'Voce creata',
    ).then((ok) => {
      if (ok) resetMenuForm();
    });
  }

  function handleToggleVisible(d: DrinkRow) {
    void runMenuAction(
      'visible:' + d.id,
      () => setDrinkVisibility(supabase, { drinkId: d.id, visibile: !d.visibile }),
      d.visibile ? 'Voce nascosta' : 'Voce resa visibile',
    );
  }

  function handleToggleActive(d: DrinkRow) {
    void runMenuAction(
      'active:' + d.id,
      () => setDrinkActive(supabase, { drinkId: d.id, attivo: !d.attivo }),
      d.attivo ? 'Voce disattivata' : 'Voce attivata',
    );
  }

  function handleDeleteDrink(d: DrinkRow) {
    void runMenuAction(
      'delete:' + d.id,
      () => deleteDrink(supabase, { drinkId: d.id }),
      'Voce eliminata',
    ).then((ok) => {
      if (ok && editingId === d.id) resetMenuForm();
    });
  }

  // ── Render: schermate pre-shell (verifica / login) ───────────────────────

  const shellBg: React.CSSProperties = {
    minHeight: '100dvh',
    background: '#190F08',
    color: '#fff',
    fontFamily: 'var(--font-ui)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  };

  // Fase A — verifica accesso in corso.
  if (!roleChecked) {
    return (
      <div style={shellBg}>
        <div style={{ ...panel, maxWidth: 420, width: '100%' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, letterSpacing: '.04em' }}>
            TOTEM NIGHT · REGIA
          </div>
          <p style={{ margin: '10px 0 0', color: C.inkMuted, fontSize: 14 }}>Verifica accesso…</p>
        </div>
      </div>
    );
  }

  // Fase B — non regia/admin → form login. (cassa NON basta per la regia.)
  if (!staff) {
    return (
      <div style={shellBg}>
        <div style={{ ...panel, maxWidth: 420, width: '100%' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, letterSpacing: '.04em' }}>
            REGIA
          </div>
          <p style={{ margin: '6px 0 18px', color: C.inkMuted, fontSize: 14 }}>
            Accedi con credenziali regia o admin. Le operazioni muovono fasi e sessioni solo
            via funzioni server (RPC).
          </p>
          <form onSubmit={handleLogin}>
            <label htmlFor="regia-email" style={labelStyle}>
              Email staff
            </label>
            <input
              id="regia-email"
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="regia@evento.it"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />

            <label htmlFor="regia-password" style={{ ...labelStyle, marginTop: 14 }}>
              Password
            </label>
            <input
              id="regia-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />

            {authError && <Note kind="err">{authError}</Note>}

            <div style={{ marginTop: 18 }}>
              <DButton type="submit" variant="primary" disabled={authBusy} full>
                {authBusy ? 'Accesso…' : 'Accedi'}
              </DButton>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ── Fase C — regia/admin loggato: shell + sidebar + tab. ─────────────────
  const currentPhase = (stats?.fase as Phase | undefined) ?? null; // dal server, NON mock
  const statoPill = stats?.fase ?? '—';
  const noEvent = eventChecked && !eventId;

  // headerRight condiviso: pill fase (dal server) + bottone Esci.
  const headerRight = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div
        style={{
          background: 'rgba(43,163,90,.12)',
          border: '1px solid rgba(43,163,90,.5)',
          color: C.green,
          borderRadius: 99,
          padding: '6px 14px',
          fontWeight: 700,
          fontSize: 13,
        }}
      >
        {statoPill}
      </div>
      <span style={{ color: C.inkMuted, fontSize: 13 }}>Ruolo: {role}</span>
      <DButton variant="ghost" onClick={handleEsci}>
        Esci
      </DButton>
    </div>
  );

  // Banner "nessun evento attivo" (riusato in cima ad ogni tab con dati).
  const noEventBanner = noEvent ? (
    <div style={{ ...panel, borderColor: 'rgba(224,106,74,.5)', color: C.inkSoft, fontSize: 14 }}>
      Nessun evento attivo.
    </div>
  ) : null;

  // ── R1 — Dashboard: KPI reali da getEventStats via RegiaDashboard. ───────
  if (tab === 'dashboard') {
    const kpis: Kpi[] = [
      { label: 'PRESENZE', value: stats?.presenze ?? '—', color: C.ink },
      { label: 'GETTONI VENDUTI', value: stats?.gettoni_venduti ?? '—', color: C.blue },
      { label: 'TICKET TOTALI', value: stats?.ticket_totali ?? '—', color: C.gold },
      { label: 'FASE', value: stats?.fase ?? '—', color: C.goldSoft },
    ];
    return (
      <div style={{ position: 'relative' }}>
        <RegiaDashboard kpis={kpis} tx={[]} stato={statoPill} onNav={setTab} />
        {/* overlay sopra la topbar della dashboard: Esci + eventuali errori/banner */}
        <div style={{ position: 'absolute', top: 18, right: 32, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ color: C.inkMuted, fontSize: 13 }}>Ruolo: {role}</span>
          <DButton variant="ghost" onClick={handleEsci}>
            Esci
          </DButton>
        </div>
        {(statsError || noEvent) && (
          <div style={{ position: 'absolute', left: 272, right: 32, bottom: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {noEvent && (
              <div style={{ ...panel, borderColor: 'rgba(224,106,74,.5)', color: C.inkSoft, fontSize: 14 }}>
                Nessun evento attivo.
              </div>
            )}
            {statsError && <Note kind="err">Statistiche non disponibili: {statsError}</Note>}
          </div>
        )}
      </div>
    );
  }

  // ── Le altre viste: RegiaShell con contenuto per tab. ────────────────────
  return (
    <RegiaShell active={tab} title={TAB_TITLE[tab]} stato={statoPill} onNav={setTab} headerRight={headerRight}>
      <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {noEventBanner}

        {/* ── R2 — Controllo fasi ───────────────────────────────────────── */}
        {tab === 'fasi' && (
          <>
            <div style={panel}>
              <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.inkMuted, marginBottom: 14 }}>
                TIMELINE FASI
              </div>
              <ol
                aria-label="Fasi della serata"
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 10 }}
              >
                {PHASES.map((phase) => {
                  const active = phase === currentPhase;
                  return (
                    <li key={phase}>
                      <span
                        aria-current={active ? 'step' : undefined}
                        style={{
                          display: 'inline-block',
                          padding: '8px 16px',
                          borderRadius: 999,
                          fontSize: 13.5,
                          fontWeight: active ? 700 : 500,
                          border: `1px solid ${active ? C.blue : C.border}`,
                          background: active ? 'rgba(58,91,190,.18)' : 'transparent',
                          color: active ? '#fff' : C.inkMuted,
                        }}
                      >
                        {PHASE_LABEL[phase]}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <p style={{ margin: '16px 0 0', color: C.inkSoft, fontSize: 14 }}>
                Fase attuale: <b style={{ color: '#fff' }}>{currentPhase ? PHASE_LABEL[currentPhase] : '—'}</b>. Le
                transizioni sono validate dal server; qui non si applica logica di stato.
              </p>
            </div>

            <div style={panel}>
              <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.inkMuted, marginBottom: 14 }}>
                IMPOSTA FASE
              </div>
              <div role="group" aria-label="Imposta fase" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {PHASES.map((phase) => {
                  const key = 'phase:' + phase;
                  const isActive = phase === currentPhase;
                  return (
                    <DButton
                      key={phase}
                      variant={isActive ? 'primary' : 'ghost'}
                      disabled={!eventId || busyAction !== null}
                      onClick={() => handleSetPhase(phase)}
                    >
                      {busyAction === key ? '…' : PHASE_LABEL[phase]}
                    </DButton>
                  );
                })}
              </div>
              {actionError && <Note kind="err">{actionError}</Note>}
              {feedback && <Note kind="ok">{feedback}</Note>}
            </div>
          </>
        )}

        {/* ── R3 — Sessioni tap: LIVE (classifica) o IDLE (lancia) ──────── */}
        {tab === 'sessioni' && (
          <>
            {/* Prima lettura in corso: nessuno stato ancora deciso. */}
            {eventId && !sessionChecked && (
              <div style={{ ...panel, color: C.inkMuted, fontSize: 14 }}>Verifica sessione…</div>
            )}

            {/* ── R3b IDLE — nessuna sessione attiva: card di lancio. ────── */}
            {eventId && sessionChecked && !activeSession && (
              <div style={{ ...panel, borderColor: C.border, textAlign: 'center', maxWidth: 560, margin: '0 auto', width: '100%' }}>
                <div style={{ fontSize: 46, lineHeight: 1 }} aria-hidden>⚡</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, marginTop: 8, letterSpacing: '.02em' }}>
                  NESSUNA SESSIONE ATTIVA
                </div>
                <div style={{ margin: '22px 0 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                  <span style={{ color: C.inkSoft, fontSize: 15 }}>Durata</span>
                  <span
                    style={{
                      width: 90,
                      height: 46,
                      borderRadius: 10,
                      background: '#190F08',
                      border: `1px solid ${C.border}`,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: 'var(--font-display)',
                      fontSize: 20,
                    }}
                  >
                    30s
                  </span>
                </div>
                <div style={{ marginTop: 22, display: 'flex', justifyContent: 'center' }}>
                  <DButton variant="gold" disabled={!eventId || busyAction !== null} onClick={handleStartSession}>
                    {busyAction === 'session' ? 'Lancio…' : 'Lancia sessione 30s'}
                  </DButton>
                </div>
                {actionError && <Note kind="err">{actionError}</Note>}
                {feedback && <Note kind="ok">{feedback}</Note>}
                {sessionError && <Note kind="err">{sessionError}</Note>}
              </div>
            )}

            {/* ── R3 LIVE — sessione attiva: countdown + classifica live. ── */}
            {eventId && activeSession && (
              <>
                {/* Header: anello countdown + titolo + Chiudi sessione. */}
                <div style={{ ...panel, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                    <CountdownRing secondi={secondsLeft ?? 0} durataTotale={30} />
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, letterSpacing: '.02em' }}>
                      CLASSIFICA LIVE
                    </div>
                  </div>
                  <DButton variant="danger" disabled={busyAction !== null} onClick={handleCloseSession}>
                    {busyAction === 'session-close' ? 'Chiusura…' : 'Chiudi sessione'}
                  </DButton>
                </div>

                {actionError && <Note kind="err">{actionError}</Note>}
                {feedback && <Note kind="ok">{feedback}</Note>}

                {/* Classifica (righe con barra) + pannello partecipanti/tap totali. */}
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 280px', gap: 24, alignItems: 'start' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {sessionError && <Note kind="err">{sessionError}</Note>}
                    {leaderboard.length === 0 && !sessionError && (
                      <div style={{ ...panel, color: C.inkMuted, fontSize: 14 }}>
                        Ancora nessun tap. La classifica si popola in tempo reale.
                      </div>
                    )}
                    {(() => {
                      // Barra proporzionale al leader (solo presentazionale: i tap_count
                      // sono CUMULATIVI dal DB, qui non si somma né si ricalcola nulla).
                      const maxTaps = leaderboard.reduce((m, r) => Math.max(m, r.tap_count), 0);
                      return leaderboard.map((r, i) => {
                        const pos = i + 1;
                        const pct = maxTaps > 0 ? Math.round((r.tap_count / maxTaps) * 100) : 0;
                        return (
                          <div
                            key={r.guest_id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 14,
                              background: C.surface,
                              border: `1px solid ${C.border}`,
                              borderRadius: 12,
                              padding: '12px 16px',
                              transition: 'background .3s ease',
                            }}
                          >
                            <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, width: 30, color: rankColor(pos) }}>
                              {pos}
                            </div>
                            <div style={{ width: 150, fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {r.nome || '—'}
                            </div>
                            <div style={{ flex: 1, minWidth: 0, height: 14, borderRadius: 99, background: '#1B0F07', overflow: 'hidden' }}>
                              <div
                                style={{
                                  height: '100%',
                                  width: `${pct}%`,
                                  borderRadius: 99,
                                  background: `linear-gradient(90deg, ${C.blue}, ${EMBER})`,
                                  transition: 'width .5s ease',
                                }}
                              />
                            </div>
                            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: C.gold, width: 60, textAlign: 'right' }}>
                              {r.tap_count}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {/* Mini-pannello derivato dalla classifica (presentazionale). */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ ...panel, padding: 20 }}>
                      <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.14em', fontSize: 11, color: C.inkMuted }}>
                        PARTECIPANTI ATTIVI
                      </div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 38 }}>{leaderboard.length}</div>
                    </div>
                    <div style={{ ...panel, padding: 20 }}>
                      <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.14em', fontSize: 11, color: C.inkMuted }}>
                        TAP TOTALI
                      </div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 38, color: EMBER }}>
                        {leaderboard.reduce((sum, r) => sum + r.tap_count, 0)}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* ── R4 — Gestione menù (CRUD) ─────────────────────────────────── */}
        {tab === 'menu' && (
          <>
            <div style={panel}>
              <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.inkMuted, marginBottom: 14 }}>
                {editingId ? 'MODIFICA VOCE' : 'NUOVA VOCE'}
              </div>
              <form onSubmit={handleSubmitDrink}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <label htmlFor="drink-nome" style={labelStyle}>
                      Nome
                    </label>
                    <input
                      id="drink-nome"
                      type="text"
                      placeholder="Mojito"
                      value={formNome}
                      onChange={(e) => setFormNome(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label htmlFor="drink-tipo" style={labelStyle}>
                      Tipo
                    </label>
                    <select
                      id="drink-tipo"
                      value={formTipo}
                      onChange={(e) => setFormTipo(e.target.value as TipoConsumazione)}
                      style={inputStyle}
                    >
                      <option value="normale">Normale</option>
                      <option value="premium">Premium</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="drink-categoria" style={labelStyle}>
                      Categoria
                    </label>
                    <input
                      id="drink-categoria"
                      type="text"
                      placeholder="Cocktail"
                      value={formCategoria}
                      onChange={(e) => setFormCategoria(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label htmlFor="drink-ordine" style={labelStyle}>
                      Ordine
                    </label>
                    <input
                      id="drink-ordine"
                      type="number"
                      inputMode="numeric"
                      value={formOrdine}
                      onChange={(e) => setFormOrdine(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                </div>
                <div style={{ marginTop: 14 }}>
                  <label htmlFor="drink-descrizione" style={labelStyle}>
                    Descrizione
                  </label>
                  <input
                    id="drink-descrizione"
                    type="text"
                    placeholder="Rum, lime, menta, zucchero"
                    value={formDescrizione}
                    onChange={(e) => setFormDescrizione(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                  <DButton type="submit" variant="primary" disabled={!eventId || menuBusy !== null}>
                    {menuBusy === 'create' || (editingId && menuBusy === 'edit:' + editingId)
                      ? 'Salvataggio…'
                      : editingId
                        ? 'Aggiorna voce'
                        : 'Crea voce'}
                  </DButton>
                  {editingId && (
                    <DButton type="button" variant="ghost" disabled={menuBusy !== null} onClick={resetMenuForm}>
                      Annulla modifica
                    </DButton>
                  )}
                </div>
              </form>
              {menuError && <Note kind="err">{menuError}</Note>}
              {menuFeedback && <Note kind="ok">{menuFeedback}</Note>}
            </div>

            <div style={panel}>
              <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.inkMuted, marginBottom: 14 }}>
                VOCI DEL LISTINO
              </div>
              {drinksError && <Note kind="err">Listino non disponibile: {drinksError}</Note>}
              {!drinksError && drinks.length === 0 && (
                <p style={{ margin: 0, color: C.inkMuted, fontSize: 14 }}>Nessuna voce nel listino.</p>
              )}
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {drinks.map((d) => (
                  <li
                    key={d.id}
                    style={{
                      border: `1px solid ${C.border}`,
                      borderRadius: 12,
                      padding: 14,
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
                      <span style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>{d.nome}</span>
                      <span style={{ fontSize: 12.5, color: C.inkMuted }}>
                        {d.tipo} · {d.categoria ?? 'senza categoria'} · ord. {d.ordine}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <DButton
                        variant={d.visibile ? 'primary' : 'ghost'}
                        disabled={menuBusy !== null}
                        onClick={() => handleToggleVisible(d)}
                      >
                        {menuBusy === 'visible:' + d.id ? '…' : d.visibile ? 'Visibile ✓' : 'Visibile ✕'}
                      </DButton>
                      <DButton
                        variant={d.attivo ? 'primary' : 'ghost'}
                        disabled={menuBusy !== null}
                        onClick={() => handleToggleActive(d)}
                      >
                        {menuBusy === 'active:' + d.id ? '…' : d.attivo ? 'Attivo ✓' : 'Attivo ✕'}
                      </DButton>
                      <DButton variant="ghost" disabled={menuBusy !== null} onClick={() => handleEditDrink(d)}>
                        Modifica
                      </DButton>
                      <DButton variant="danger" disabled={menuBusy !== null} onClick={() => handleDeleteDrink(d)}>
                        {menuBusy === 'delete:' + d.id ? 'Elimino…' : 'Elimina'}
                      </DButton>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {/* ── R5 — Impostazioni evento ──────────────────────────────────── */}
        {tab === 'impostazioni' && (
          <div style={panel}>
            <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.inkMuted, marginBottom: 6 }}>
              PARAMETRI EVENTO
            </div>
            <p style={{ margin: '0 0 18px', color: C.inkSoft, fontSize: 13.5 }}>
              Campi vuoti = non modificare (il server fa coalesce sul valore corrente).
            </p>
            <form onSubmit={handleSaveSettings}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label htmlFor="set-normale" style={labelStyle}>
                    Prezzo Normale (€)
                  </label>
                  <input
                    id="set-normale"
                    type="number"
                    inputMode="decimal"
                    placeholder="es. 5"
                    value={setNormale}
                    onChange={(e) => setSetNormale(e.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label htmlFor="set-premium" style={labelStyle}>
                    Prezzo Premium (€)
                  </label>
                  <input
                    id="set-premium"
                    type="number"
                    inputMode="decimal"
                    placeholder="es. 8"
                    value={setPremium}
                    onChange={(e) => setSetPremium(e.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label htmlFor="set-durata" style={labelStyle}>
                    Durata sessione (s)
                  </label>
                  <input
                    id="set-durata"
                    type="number"
                    inputMode="numeric"
                    placeholder="es. 30"
                    value={setDurata}
                    onChange={(e) => setSetDurata(e.target.value)}
                    style={inputStyle}
                  />
                </div>
              </div>
              <div style={{ marginTop: 18 }}>
                <DButton type="submit" variant="primary" disabled={!eventId || settingsBusy}>
                  {settingsBusy ? 'Salvataggio…' : 'Salva impostazioni'}
                </DButton>
              </div>
            </form>
            {settingsError && <Note kind="err">{settingsError}</Note>}
            {settingsFeedback && <Note kind="ok">{settingsFeedback}</Note>}
          </div>
        )}

        {/* ── R6 — Estrazione (draw panel) + R6b reveal stage ───────────── */}
        {tab === 'estrazione' && (
          <>
            {/* R6 · Pannello sorteggio: stats presentazionali + stepper + ESTRAI ORA. */}
            <div
              style={{
                ...panel,
                maxWidth: 620,
                margin: '0 auto',
                width: '100%',
                textAlign: 'center',
                padding: 40,
                boxShadow: '0 0 60px rgba(242,180,60,.08)',
              }}
            >
              {/* Biglietti in gioco / partecipanti — DATI dal server (stats), mai calcolati. */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: 40 }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 40, color: C.gold }}>
                    {stats?.ticket_totali ?? '—'}
                  </div>
                  <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.14em', fontSize: 11, color: C.inkMuted }}>
                    BIGLIETTI IN GIOCO
                  </div>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 40 }}>
                    {stats?.presenze ?? '—'}
                  </div>
                  <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.14em', fontSize: 11, color: C.inkMuted }}>
                    PARTECIPANTI
                  </div>
                </div>
              </div>

              {/* Stepper numero vincitori (default 3). Solo input UI: il server è autoritativo. */}
              <div style={{ marginTop: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
                <div style={{ fontSize: 15, color: C.inkSoft }}>Numero vincitori</div>
                <div role="group" aria-label="Numero vincitori" style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                  <button
                    type="button"
                    aria-label="Diminuisci"
                    disabled={busyAction !== null || nWinners <= 1}
                    onClick={() => setNWinners((n) => Math.max(1, n - 1))}
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 12,
                      border: `1px solid ${C.border}`,
                      background: 'transparent',
                      color: C.inkSoft,
                      fontSize: 26,
                      lineHeight: 1,
                      cursor: busyAction !== null || nWinners <= 1 ? 'not-allowed' : 'pointer',
                      opacity: busyAction !== null || nWinners <= 1 ? 0.5 : 1,
                    }}
                  >
                    −
                  </button>
                  <div
                    aria-live="polite"
                    style={{ fontFamily: 'var(--font-display)', fontSize: 44, width: 60, textAlign: 'center' }}
                  >
                    {nWinners}
                  </div>
                  <button
                    type="button"
                    aria-label="Aumenta"
                    disabled={busyAction !== null}
                    onClick={() => setNWinners((n) => n + 1)}
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 12,
                      border: '1px solid transparent',
                      background: C.blue,
                      color: '#fff',
                      fontSize: 26,
                      lineHeight: 1,
                      cursor: busyAction !== null ? 'not-allowed' : 'pointer',
                      opacity: busyAction !== null ? 0.5 : 1,
                    }}
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Primary oro grande "ESTRAI ORA" → runDraw(nWinners). */}
              <button
                type="button"
                disabled={!eventId || busyAction !== null}
                onClick={handleDraw}
                style={{
                  marginTop: 36,
                  width: '100%',
                  height: 64,
                  borderRadius: 14,
                  border: 'none',
                  background: `linear-gradient(90deg, ${C.gold}, ${EMBER})`,
                  color: '#1A0F08',
                  fontFamily: 'var(--font-display)',
                  fontSize: 24,
                  letterSpacing: '.06em',
                  boxShadow: '0 0 36px rgba(242,180,60,.4)',
                  cursor: !eventId || busyAction !== null ? 'not-allowed' : 'pointer',
                  opacity: !eventId || busyAction !== null ? 0.6 : 1,
                }}
              >
                {busyAction === 'draw' ? 'ESTRAZIONE…' : 'ESTRAI ORA'}
              </button>

              <div style={{ marginTop: 16, color: C.inkMuted, fontSize: 13 }}>
                Sorteggio pesato sui ticket. Seed e lista salvati per verifica.
              </div>

              {actionError && <Note kind="err">{actionError}</Note>}
              {feedback && <Note kind="ok">{feedback}</Note>}
            </div>

            {/* R6b · Reveal stage: podio vincitori DAL SERVER (getLastDraw), mai inventati. */}
            {eventId && lastDrawChecked && !lastDraw && !lastDrawError && (
              <div style={{ ...panel, color: C.inkMuted, fontSize: 14, textAlign: 'center', maxWidth: 620, margin: '0 auto', width: '100%' }}>
                Nessuna estrazione ancora eseguita. Il reveal comparirà qui dopo il sorteggio.
              </div>
            )}
            {lastDrawError && (
              <div style={{ maxWidth: 620, margin: '0 auto', width: '100%' }}>
                <Note kind="err">Estrazione non disponibile: {lastDrawError}</Note>
              </div>
            )}

            {eventId && lastDraw && lastDraw.winners.length > 0 && (
              <div
                style={{
                  position: 'relative',
                  borderRadius: 20,
                  border: `1px solid ${C.border}`,
                  overflow: 'hidden',
                  background: 'radial-gradient(60% 60% at 50% 30%, rgba(242,180,60,.22) 0%, transparent 62%), #190F08',
                  padding: '48px 32px 40px',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.34em', fontSize: 16, color: C.inkSoft }}>
                  {lastDraw.winners.length > 1 ? 'I VINCITORI SONO' : 'IL VINCITORE È'}
                </div>

                {/* Vincitore principale (pos 1) in grande; eventuali altri nel podio sotto. */}
                {(() => {
                  const sorted = [...lastDraw.winners].sort((a, b) => a.pos - b.pos);
                  const [first, ...rest] = sorted;
                  return (
                    <>
                      <div
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontSize: 72,
                          color: C.gold,
                          lineHeight: 0.95,
                          marginTop: 10,
                          textShadow: '0 0 60px rgba(242,180,60,.6)',
                          wordBreak: 'break-word',
                        }}
                      >
                        {first?.nome || '—'}
                      </div>
                      <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.2em', fontSize: 16, color: '#fff', marginTop: 14 }}>
                        {(first?.tickets ?? 0)} TICKET · {first?.pos ?? 1}° POSTO
                      </div>

                      {rest.length > 0 && (
                        <ul
                          aria-label="Altri vincitori"
                          style={{
                            listStyle: 'none',
                            margin: '30px auto 0',
                            padding: 0,
                            display: 'flex',
                            flexWrap: 'wrap',
                            justifyContent: 'center',
                            gap: 14,
                            maxWidth: 720,
                          }}
                        >
                          {rest.map((w) => (
                            <li
                              key={w.guest_id}
                              style={{
                                minWidth: 150,
                                background: C.surface,
                                border: `1px solid ${C.border}`,
                                borderRadius: 14,
                                padding: '14px 18px',
                              }}
                            >
                              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: rankColor(w.pos) }}>
                                {w.pos}°
                              </div>
                              <div style={{ fontWeight: 700, fontSize: 15, color: '#fff', marginTop: 2, wordBreak: 'break-word' }}>
                                {w.nome || '—'}
                              </div>
                              <div style={{ fontSize: 12.5, color: C.inkMuted, marginTop: 2 }}>
                                {w.tickets} ticket
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  );
                })()}

                {/* Meta estrazione: seed + n. vincitori (verifica), dalla stessa riga draws. */}
                <div style={{ marginTop: 30, color: C.inkMuted, fontSize: 12.5, fontFamily: 'var(--font-ui)' }}>
                  {lastDraw.n_winners} vincitori · seed {lastDraw.seed ?? '—'} · {new Date(lastDraw.created_at).toLocaleString('it-IT')}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── R7 — Ledger / riconciliazione (SOLA LETTURA) ──────────────── */}
        {tab === 'ledger' && (
          <>
            {/* Barra azioni: refresh + esporta CSV (delle righe già ricevute). */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.inkMuted }}>
                RICONCILIAZIONE MOVIMENTI
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <DButton
                  variant="ghost"
                  disabled={!eventId || ledgerBusy}
                  onClick={() => void refetchLedger()}
                >
                  {ledgerBusy ? 'Aggiorno…' : 'Aggiorna'}
                </DButton>
                <DButton
                  variant="ghost"
                  disabled={!ledger || ledger.righe.length === 0}
                  onClick={() => ledger && exportLedgerCsv(ledger.righe, guestNameById)}
                >
                  Esporta CSV
                </DButton>
              </div>
            </div>

            {/* Striscia TOTALI — AGGREGATI dal server (mai ricalcolati nel client). */}
            <div
              style={{
                display: 'flex',
                gap: 32,
                flexWrap: 'wrap',
                padding: '16px 20px',
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 14,
              }}
            >
              <div>
                <span style={{ color: C.inkMuted, fontSize: 13 }}>Incasso ricariche</span>
                <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginLeft: 8, fontVariantNumeric: 'tabular-nums' }}>
                  {ledger ? fmtEuro(ledger.totali.incasso_euro) : '—'}
                </b>
              </div>
              <div>
                <span style={{ color: C.inkMuted, fontSize: 13 }}>Gettoni emessi</span>
                <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginLeft: 8, fontVariantNumeric: 'tabular-nums' }}>
                  {ledger ? fmtInt(ledger.totali.gettoni_emessi) : '—'}
                </b>
              </div>
              <div>
                <span style={{ color: C.inkMuted, fontSize: 13 }}>Ticket emessi</span>
                <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginLeft: 8, color: C.gold, fontVariantNumeric: 'tabular-nums' }}>
                  {ledger ? fmtInt(ledger.totali.ticket_emessi) : '—'}
                </b>
              </div>
            </div>

            {ledgerError && <Note kind="err">Ledger non disponibile: {ledgerError}</Note>}

            {/* Tabella append-only (cifre tabellari). Header + righe (created_at desc). */}
            <div style={panel}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '90px 1fr 1.2fr 1fr 110px 110px 120px',
                  gap: 12,
                  padding: '0 14px 12px',
                  fontFamily: 'var(--font-ritual)',
                  letterSpacing: '.08em',
                  fontSize: 11,
                  color: C.inkMuted,
                }}
              >
                <div>ORA</div>
                <div>TIPO</div>
                <div>OSPITE</div>
                <div>OPERATORE</div>
                <div style={{ textAlign: 'right' }}>Δ GETTONI</div>
                <div style={{ textAlign: 'right' }}>Δ TICKET</div>
                <div style={{ textAlign: 'right' }}>IMPORTO</div>
              </div>

              {/* Stato di caricamento / vuoto coerente. */}
              {eventId && !ledgerChecked && (
                <p style={{ margin: '6px 0 0', color: C.inkMuted, fontSize: 14 }}>Carico i movimenti…</p>
              )}
              {ledgerChecked && !ledgerError && ledger && ledger.righe.length === 0 && (
                <p style={{ margin: '6px 0 0', color: C.inkMuted, fontSize: 14 }}>
                  Nessun movimento registrato per questo evento.
                </p>
              )}

              {ledger &&
                ledger.righe.map((r) => {
                  const chip = LEDGER_TIPO_CHIP[r.tipo];
                  const gColor = r.qta_delta > 0 ? C.green : r.qta_delta < 0 ? EMBER : C.inkMuted;
                  return (
                    <div
                      key={r.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '90px 1fr 1.2fr 1fr 110px 110px 120px',
                        gap: 12,
                        alignItems: 'center',
                        padding: '13px 14px',
                        borderBottom: `1px solid ${C.border}`,
                        fontSize: 13.5,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <div style={{ color: C.inkSoft }}>
                        {new Date(r.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div>
                        <span
                          style={{
                            fontFamily: 'var(--font-ritual)',
                            fontSize: 10,
                            letterSpacing: '.06em',
                            border: `1px solid ${chip.border}`,
                            color: chip.color,
                            borderRadius: 6,
                            padding: '4px 8px',
                            textTransform: 'uppercase',
                          }}
                        >
                          {r.tipo}
                          {r.tipo_consumazione ? ` · ${r.tipo_consumazione}` : ''}
                        </span>
                      </div>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {guestNameById.get(r.guest_id) ?? (
                          <span style={{ color: C.inkMuted, fontFamily: 'var(--font-ui)' }}>
                            {r.guest_id.slice(0, 8)}…
                          </span>
                        )}
                      </div>
                      <div style={{ color: C.inkSoft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.operatore ? r.operatore.slice(0, 8) + '…' : 'ospite'}
                      </div>
                      <div style={{ textAlign: 'right', color: gColor }}>
                        {r.qta_delta !== 0 ? fmtDelta(r.qta_delta) : '—'}
                      </div>
                      <div style={{ textAlign: 'right', color: r.ticket_delta > 0 ? C.gold : C.inkMuted }}>
                        {r.ticket_delta !== 0 ? fmtDelta(r.ticket_delta) : '—'}
                      </div>
                      <div style={{ textAlign: 'right', color: C.inkSoft }}>
                        {r.importo_euro !== null ? fmtEuro(Number(r.importo_euro)) : '—'}
                      </div>
                    </div>
                  );
                })}

              {ledger && ledger.righe.length >= 100 && (
                <p style={{ margin: '12px 0 0', color: C.inkMuted, fontSize: 12.5 }}>
                  Mostrate le ultime 100 righe (più recenti). I totali coprono l&apos;intero evento.
                </p>
              )}
            </div>
          </>
        )}

        {/* ── R8 — Ospiti (lista + drawer dettaglio, SOLA LETTURA) ──────── */}
        {tab === 'ospiti' && (
          <>
            {/* Barra: ricerca (client-side, presentazionale) + refresh. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <input
                type="search"
                aria-label="Cerca ospite per nome o PIN"
                placeholder="Cerca per nome o PIN…"
                value={guestSearch}
                onChange={(e) => setGuestSearch(e.target.value)}
                style={{ ...inputStyle, width: 280 }}
              />
              <DButton variant="ghost" disabled={!eventId} onClick={() => void refetchGuests()}>
                Aggiorna
              </DButton>
            </div>

            {guestsError && <Note kind="err">Ospiti non disponibili: {guestsError}</Note>}

            <div style={panel}>
              {/* Header tabella. */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.4fr 90px 90px 90px 110px 1fr',
                  gap: 12,
                  padding: '0 14px 12px',
                  fontFamily: 'var(--font-ritual)',
                  letterSpacing: '.08em',
                  fontSize: 11,
                  color: C.inkMuted,
                }}
              >
                <div>NOME</div>
                <div>PIN</div>
                <div>NORM.</div>
                <div>PREM.</div>
                <div>TICKET</div>
                <div>LIVELLO TOTEM</div>
              </div>

              {/* Stato caricamento / vuoto. */}
              {eventId && !guestsChecked && (
                <p style={{ margin: '6px 0 0', color: C.inkMuted, fontSize: 14 }}>Carico gli ospiti…</p>
              )}
              {guestsChecked && !guestsError && guests.length === 0 && (
                <p style={{ margin: '6px 0 0', color: C.inkMuted, fontSize: 14 }}>
                  Nessun ospite registrato per questo evento.
                </p>
              )}
              {guestsChecked && !guestsError && guests.length > 0 && filteredGuests.length === 0 && (
                <p style={{ margin: '6px 0 0', color: C.inkMuted, fontSize: 14 }}>
                  Nessun ospite corrisponde a “{guestSearch}”.
                </p>
              )}

              {filteredGuests.map((g) => {
                const isSel = selectedGuest?.id === g.id;
                // Barra livello proporzionale (0..6): SOLO presentazionale, il livello è dal DB.
                const lvlPct = Math.round((Math.max(0, Math.min(6, g.livello_totem)) / 6) * 100);
                return (
                  <div
                    key={g.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Dettaglio ospite ${g.nome}`}
                    onClick={() => setSelectedGuest(g)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedGuest(g);
                      }
                    }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.4fr 90px 90px 90px 110px 1fr',
                      gap: 12,
                      alignItems: 'center',
                      padding: '13px 14px',
                      borderRadius: 9,
                      background: isSel ? 'rgba(58,91,190,.14)' : 'transparent',
                      borderBottom: `1px solid ${C.border}`,
                      fontSize: 14,
                      cursor: 'pointer',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {g.nome || '—'}
                    </div>
                    <div style={{ color: C.inkSoft }}>{g.pin}</div>
                    <div>{g.saldo_normale}</div>
                    <div style={{ color: '#9BB6EC' }}>{g.saldo_premium}</div>
                    <div style={{ color: C.gold, fontWeight: 600 }}>{g.ticket_totali}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, maxWidth: 120, height: 7, borderRadius: 99, background: '#20140B' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${lvlPct}%`,
                            borderRadius: 99,
                            background: `linear-gradient(90deg, ${C.blue}, ${C.gold})`,
                          }}
                        />
                      </div>
                      <span style={{ fontFamily: 'var(--font-ritual)', fontSize: 11, color: C.gold }}>
                        L{g.livello_totem}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ── R8 drawer dettaglio ospite (overlay, sola lettura) ──────────── */}
      {tab === 'ospiti' && selectedGuest && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Dettaglio ospite ${selectedGuest.nome}`}
          style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}
        >
          {/* Scrim: click fuori → chiude. */}
          <div
            onClick={() => setSelectedGuest(null)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(9,5,2,.55)' }}
          />
          <aside
            style={{
              position: 'relative',
              width: 420,
              maxWidth: '100%',
              height: '100%',
              overflowY: 'auto',
              background: C.surface,
              borderLeft: `1px solid ${C.border}`,
              padding: 28,
              boxShadow: '-20px 0 60px rgba(0,0,0,.4)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, letterSpacing: '.02em', wordBreak: 'break-word' }}>
                  {selectedGuest.nome || '—'}
                </div>
                <div style={{ fontSize: 13, color: C.inkMuted, marginTop: 2 }}>PIN {selectedGuest.pin}</div>
              </div>
              <button
                type="button"
                aria-label="Chiudi dettaglio"
                onClick={() => setSelectedGuest(null)}
                style={{ background: 'transparent', border: 'none', color: '#7E6A52', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}
              >
                ✕
              </button>
            </div>

            {/* Mini-totem al livello attuale (dal DB, mai ricalcolato). */}
            <div style={{ display: 'flex', justifyContent: 'center', margin: '16px 0' }}>
              <Totem level={selectedGuest.livello_totem} size={150} />
            </div>

            {/* Saldi + ticket (sola lettura). */}
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, background: '#1B0F07', border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>{selectedGuest.saldo_normale}</div>
                <div style={{ fontSize: 10, color: C.inkMuted, letterSpacing: '.1em' }}>NORMALI</div>
              </div>
              <div style={{ flex: 1, background: '#1B0F07', border: '1px solid #5E83CE66', borderRadius: 10, padding: 12, textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: '#9BB6EC' }}>{selectedGuest.saldo_premium}</div>
                <div style={{ fontSize: 10, color: C.goldSoft, letterSpacing: '.1em' }}>PREMIUM</div>
              </div>
              <div style={{ flex: 1, background: 'rgba(216,154,62,.08)', border: '1px solid rgba(216,154,62,.3)', borderRadius: 10, padding: 12, textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: C.gold }}>{selectedGuest.ticket_totali}</div>
                <div style={{ fontSize: 10, color: C.gold, letterSpacing: '.1em' }}>TICKET</div>
              </div>
            </div>

            {/* Livello totem (etichetta). */}
            <div style={{ marginTop: 14, textAlign: 'center', fontSize: 13, color: C.inkSoft }}>
              Livello totem: <b style={{ color: C.gold, fontFamily: 'var(--font-ritual)' }}>L{selectedGuest.livello_totem}</b>
            </div>

            {/* Timeline transazioni: righe del ledger filtrate per guest_id (se caricato). */}
            <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.14em', fontSize: 11, color: C.inkMuted, margin: '22px 0 12px' }}>
              TIMELINE
            </div>
            {!ledger ? (
              <p style={{ margin: 0, color: C.inkMuted, fontSize: 13 }}>
                Apri il tab Ledger per caricare i movimenti: la timeline delle transazioni dell&apos;ospite comparirà qui.
              </p>
            ) : selectedGuestTimeline.length === 0 ? (
              <p style={{ margin: 0, color: C.inkMuted, fontSize: 13 }}>
                Nessun movimento recente per questo ospite (fra le ultime 100 righe del ledger).
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {selectedGuestTimeline.map((r) => {
                  const chip = LEDGER_TIPO_CHIP[r.tipo];
                  // Delta mostrato nel drawer: ticket se presente, altrimenti gettoni.
                  const deltaVal = r.ticket_delta !== 0 ? r.ticket_delta : r.qta_delta;
                  const deltaColor = deltaVal > 0 ? C.gold : deltaVal < 0 ? EMBER : C.inkMuted;
                  return (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: 7,
                          background: 'rgba(255,255,255,.04)',
                          border: `1px solid ${chip.border}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          color: chip.color,
                          fontFamily: 'var(--font-ritual)',
                        }}
                        aria-hidden
                      >
                        {r.tipo.slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                        <span style={{ textTransform: 'capitalize' }}>{r.tipo}</span>
                        {r.tipo_consumazione ? ` · ${r.tipo_consumazione}` : ''}
                        <span style={{ color: C.inkMuted, marginLeft: 6, fontSize: 11.5 }}>
                          {new Date(r.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: deltaColor, fontVariantNumeric: 'tabular-nums' }}>
                        {r.ticket_delta !== 0 ? `${fmtDelta(r.ticket_delta)} tk` : fmtDelta(r.qta_delta)}
                        {r.importo_euro !== null ? ` · ${fmtEuro(Number(r.importo_euro))}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      )}
    </RegiaShell>
  );
}
