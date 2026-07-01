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
  RpcError,
  type EventStats,
  type DrinkRow,
  type TipoConsumazione,
} from '@/lib/rpc';
import {
  setPhase,
  startSession,
  runDraw,
  updateEventSettings,
  upsertDrink,
  deleteDrink,
  setDrinkVisibility,
  setDrinkActive,
  type Phase,
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
      () => startSession(supabase, { eventId: eventId as string, durata: 30 }),
      'Sessione 30s lanciata',
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

        {/* ── R3 — Sessioni tap ─────────────────────────────────────────── */}
        {tab === 'sessioni' && (
          <>
            <div style={panel}>
              <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.inkMuted, marginBottom: 10 }}>
                LANCIA SESSIONE
              </div>
              <p style={{ margin: '0 0 16px', color: C.inkSoft, fontSize: 14 }}>
                Avvia una sessione tap da 30 secondi. Fase attuale:{' '}
                <b style={{ color: '#fff' }}>{currentPhase ? PHASE_LABEL[currentPhase] : '—'}</b>.
              </p>
              <DButton
                variant="gold"
                disabled={!eventId || busyAction !== null}
                onClick={handleStartSession}
              >
                {busyAction === 'session' ? 'Lancio…' : 'Lancia sessione 30s'}
              </DButton>
              {actionError && <Note kind="err">{actionError}</Note>}
              {feedback && <Note kind="ok">{feedback}</Note>}
            </div>

            <div style={{ ...panel, color: C.inkMuted, fontSize: 14 }}>
              <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: C.gold, marginBottom: 8 }}>
                CLASSIFICA LIVE — IN ARRIVO
              </div>
              La leaderboard tap in tempo reale non è ancora disponibile (endpoint dedicato non
              cablato). Placeholder coerente col design: nessun dato inventato.
            </div>
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
