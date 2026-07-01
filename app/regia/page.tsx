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
  RpcError,
  type EventStats,
  type DrinkRow,
  type TipoConsumazione,
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
  type Phase,
  type LeaderboardRow,
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

// Placeholder shell coerente per le sezioni non ancora disponibili (R7/R8 e simili).
function ComingSoon({ label }: { label: string }) {
  return (
    <div style={{ ...panel, color: C.inkMuted, fontSize: 14 }}>
      <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.gold, marginBottom: 8 }}>
        IN ARRIVO
      </div>
      {label}
    </div>
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

  // ── Estrazione (esito ultimo run) ───────────────────────────────────────
  const [drawResult, setDrawResult] = useState<string | null>(null);

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

  const staff = isStaffRole(role) && (role === 'regia' || role === 'admin');

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
    setDrawResult(null);
    setActiveSession(null);
    setSessionChecked(false);
    setSessionError(null);
    setLeaderboard([]);
    setSecondsLeft(null);
    setDrinks([]);
    setDrinksError(null);
    setMenuError(null);
    setMenuFeedback(null);
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
    setDrawResult(null);
    void runAction(
      'draw',
      async () => {
        // L'estrazione vive in fase ESTRAZIONE: se non ci siamo, portiamoci prima.
        if (stats && stats.fase !== 'ESTRAZIONE') {
          await setPhase(supabase, { eventId: eventId as string, phase: 'ESTRAZIONE' });
        }
        const res = await runDraw(supabase, { eventId: eventId as string, nWinners: 3 });
        // Esito solo presentazionale: il server è autoritativo, qui non sorteggiamo.
        setDrawResult(
          typeof res === 'string' ? res : 'Estrazione completata — 3 vincitori',
        );
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

        {/* ── R6 — Estrazione ───────────────────────────────────────────── */}
        {tab === 'estrazione' && (
          <div style={panel}>
            <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.inkMuted, marginBottom: 10 }}>
              SORTEGGIO
            </div>
            <p style={{ margin: '0 0 8px', color: C.inkSoft, fontSize: 14 }}>
              Biglietti in gioco: <b style={{ color: C.gold }}>{stats?.ticket_totali ?? '—'}</b> ·
              Presenze: <b style={{ color: '#fff' }}>{stats?.presenze ?? '—'}</b>
            </p>
            <p style={{ margin: '0 0 16px', color: C.inkMuted, fontSize: 13 }}>
              Estrazione pesata sui ticket, eseguita dal server. Se l&apos;evento non è già in fase
              ESTRAZIONE ci viene portato prima del sorteggio.
            </p>
            <DButton variant="gold" disabled={!eventId || busyAction !== null} onClick={handleDraw}>
              {busyAction === 'draw' ? 'Estrazione…' : 'Estrai ora (3 vincitori)'}
            </DButton>
            {actionError && <Note kind="err">{actionError}</Note>}
            {feedback && <Note kind="ok">{feedback}</Note>}
            {drawResult && (
              <div
                style={{
                  marginTop: 16,
                  padding: 16,
                  borderRadius: 12,
                  border: `1px solid ${C.gold}`,
                  background: 'rgba(216,154,62,.08)',
                  color: C.goldSoft,
                  fontSize: 14,
                }}
              >
                {drawResult}
              </div>
            )}
          </div>
        )}

        {/* ── R7 — Ledger (placeholder) ─────────────────────────────────── */}
        {tab === 'ledger' && (
          <ComingSoon label="Ledger / riconciliazione: la tabella movimenti e i totali di riconciliazione non sono ancora cablati. In arrivo." />
        )}

        {/* ── R8 — Ospiti (placeholder) ─────────────────────────────────── */}
        {tab === 'ospiti' && (
          <ComingSoon label="Ospiti: lista e dettaglio ospite (con storico transazioni) non ancora cablati. In arrivo." />
        )}
      </div>
    </RegiaShell>
  );
}
