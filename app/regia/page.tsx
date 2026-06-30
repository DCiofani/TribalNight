// TEMP — swappabile quando arriva il design (Claude Design).
//
// Schermata REGIA (spec §10): pannello dell'organizzatore — CABLATA al backend.
// Modellata su app/cassa/page.tsx: gate ruolo (regia/admin), istanza supabase stabile,
// busy/error per ogni azione. Il front-end NON calcola MAI: fase e statistiche
// (presenze / gettoni venduti / ticket totali) arrivano dal server via getEventStats.
//
// FLUSSO:
//   1) Gate ruolo: getSessionRole → isStaffRole (regia|admin). cassa NON basta.
//   2) eventId via getCurrentEventId.
//   3) READ-ONLY: fetch iniziale getEventStats → { fase, presenze, gettoni_venduti,
//      ticket_totali }. currentPhase deriva da stats.fase (niente più mock).
//   4) LIVE: EventSource('/api/stream/regia?event=…') solo se USE_API → su evento
//      'phase' aggiorna la fase dal payload e RIFETCH stats. Fallback (=!USE_API o
//      EventSource non disponibile): polling getEventStats ~3s. Cleanup su unmount.
//   5) CONTROLLI (muta-stato): set_phase per ogni fase, startSession 30s, runDraw.
//      Dopo ogni mutazione → rifetch stats. Nessun calcolo lato client.
//
// La pagina resta un placeholder presentazionale sostituibile dal design.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Screen, Card, Button, Stat } from '@/components/ui';
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
import { getEventStats, RpcError, type EventStats } from '@/lib/rpc';
import { setPhase, startSession, runDraw, type Phase } from '@/lib/regia';

// Fasi del flusso serata (spec §10). Ordine/labels per l'indicatore e i controlli;
// la fase REALE arriva da stats.fase (server-authoritative), mai dedotta dal client.
const PHASES: Phase[] = ['SETUP', 'APERTA', 'LAST_CALL', 'ESTRAZIONE', 'CHIUSA'];

const PHASE_LABEL: Record<Phase, string> = {
  SETUP: 'Setup',
  APERTA: 'Aperta',
  LAST_CALL: 'Last call',
  ESTRAZIONE: 'Estrazione',
  CHIUSA: 'Chiusa',
};

// Stile condiviso degli input del form login (token CSS, niente hex hardcoded).
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 12,
  fontSize: 16,
  color: 'var(--ink-0)',
  background: 'var(--night-800)',
  border: '1px solid var(--night-700)',
  outlineColor: 'var(--eden-lavender)',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 8,
};

// Intervallo polling di FALLBACK (path supabase o EventSource non disponibile):
// rilegge le stats ogni ~3s. In modalità API+SSE NON si fa polling: push via stream.
const POLL_MS = 3000;

export default function RegiaPage() {
  // Istanza supabase singola e stabile per tutta la vita della pagina.
  const supabase = useMemo(() => createClient(), []);

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
  // I 4 valori del contratto EventStats. Default null finché il primo fetch torna.
  const [stats, setStats] = useState<EventStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  // ── Controlli (muta-stato) ──────────────────────────────────────────────
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const staff = isStaffRole(role) && (role === 'regia' || role === 'admin');

  // Ref alla funzione di fetch stats per usarla dentro lo stream/polling senza
  // ricrearne l'effetto ad ogni render (eventId è la sola dipendenza che conta).
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
      setStatsError(
        err instanceof Error ? err.message : 'Statistiche non disponibili',
      );
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

    // Fetch iniziale: popola subito le 4 stat e la fase corrente.
    void refetchStats();

    // ── Path API (Fase 4): REALTIME via EventSource. ──────────────────────
    // Su evento 'phase' aggiorniamo la fase dal payload (ottimistico) e RIFETCH
    // le stats autoritative. Nessun polling in questo path.
    if (USE_API && typeof EventSource !== 'undefined') {
      let es: EventSource | null = null;
      try {
        es = new EventSource(
          '/api/stream/regia?event=' + encodeURIComponent(eventId),
          { withCredentials: true },
        );
      } catch {
        es = null;
      }

      if (es) {
        const onPhase = (ev: MessageEvent) => {
          if (!active) return;
          // Il payload porta { fase }: aggiorna subito l'indicatore, poi rilegge
          // le stats autoritative (presenze/gettoni/ticket coerenti con la fase).
          try {
            const data = JSON.parse(ev.data) as { fase?: string };
            if (data && typeof data.fase === 'string') {
              setStats((prev) =>
                prev ? { ...prev, fase: data.fase as string } : prev,
              );
            }
          } catch {
            // payload non-JSON / vuoto: ignora, il refetch riallinea comunque.
          }
          void refetchStats();
        };

        // L'apertura riuscita = momento buono per un refetch autoritativo.
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
      // EventSource non costruibile: cadi nel polling sotto.
    }

    // ── Fallback: polling ~3s (path supabase o EventSource non disponibile). ─
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

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await staffSignIn(supabase, email, password);
      // Login riuscito ≠ è regia: ricontrollo esplicito del ruolo (regia|admin).
      const r = await getSessionRole(supabase);
      if (isStaffRole(r) && (r === 'regia' || r === 'admin')) {
        setRole(r);
        setPassword('');
      } else {
        // Non lasciare appesa una sessione senza permessi regia.
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
    void runAction(
      'draw',
      async () => {
        // L'estrazione vive in fase ESTRAZIONE: se non ci siamo, portiamoci prima.
        if (stats && stats.fase !== 'ESTRAZIONE') {
          await setPhase(supabase, { eventId: eventId as string, phase: 'ESTRAZIONE' });
        }
        return runDraw(supabase, { eventId: eventId as string, nWinners: 3 });
      },
      'Estrazione eseguita',
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Fase A — verifica accesso in corso.
  if (!roleChecked) {
    return (
      <Screen kicker="Regia" title="Pannello organizzatore">
        <Card>
          <p style={{ margin: 0, color: 'var(--ink-300)', fontSize: 14 }}>
            Verifica accesso…
          </p>
        </Card>
      </Screen>
    );
  }

  // Fase B — non regia/admin → form login. (cassa NON basta per la regia.)
  if (!staff) {
    return (
      <Screen kicker="Regia" title="Pannello organizzatore">
        <Card style={{ borderColor: 'var(--ember)' }}>
          <p className="tag" style={{ margin: 0 }}>Solo organizzatore</p>
          <p style={{ margin: '6px 0 0', color: 'var(--ink-300)', fontSize: 14 }}>
            Accedi con le credenziali regia o admin. Le operazioni muovono fasi e
            sessioni solo via funzioni server (RPC).
          </p>
        </Card>

        <Card style={{ marginTop: 16 }}>
          <form onSubmit={handleLogin}>
            <label htmlFor="regia-email" className="tag" style={labelStyle}>
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

            <label
              htmlFor="regia-password"
              className="tag"
              style={{ ...labelStyle, marginTop: 12 }}
            >
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

            {authError && (
              <p style={{ margin: '12px 0 0', color: 'var(--ember)', fontSize: 14 }}>
                {authError}
              </p>
            )}

            <div style={{ marginTop: 16 }}>
              <Button type="submit" disabled={authBusy}>
                {authBusy ? 'Accesso…' : 'Accedi'}
              </Button>
            </div>
          </form>
        </Card>
      </Screen>
    );
  }

  // Fase C — regia/admin loggato.
  const currentPhase = stats?.fase ?? null; // deriva dal server, NON più mock

  return (
    <Screen kicker="Regia" title="Pannello organizzatore">
      <Card style={{ borderColor: 'var(--ember)' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <p className="tag" style={{ margin: 0 }}>Organizzatore</p>
            <p style={{ margin: '6px 0 0', color: 'var(--ink-300)', fontSize: 14 }}>
              Ruolo: {role}. Fasi e sessioni passano solo dalle RPC server.
            </p>
          </div>
          <div style={{ width: 120, flexShrink: 0 }}>
            <Button variant="ghost" onClick={handleEsci}>
              Esci
            </Button>
          </div>
        </div>
      </Card>

      {/* Nessun evento attivo: stato esplicito, niente controlli. */}
      {eventChecked && !eventId && (
        <Card style={{ marginTop: 16, borderColor: 'var(--ember)' }}>
          <p style={{ margin: 0, color: 'var(--ink-300)', fontSize: 14 }}>
            Nessun evento attivo.
          </p>
        </Card>
      )}

      {/* Indicatore di fase — valore reale da stats.fase (server). */}
      <Card style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="tag">Fase serata</p>
        <ol
          aria-label="Fasi della serata"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {PHASES.map((phase) => {
            const active = phase === currentPhase;
            return (
              <li key={phase}>
                <span
                  aria-current={active ? 'step' : undefined}
                  style={{
                    display: 'inline-block',
                    padding: '6px 12px',
                    borderRadius: 999,
                    fontSize: 13,
                    fontWeight: active ? 700 : 500,
                    border: `1px solid ${
                      active ? 'var(--eden-violet)' : 'var(--night-700)'
                    }`,
                    background: active ? 'var(--eden-violet)' : 'transparent',
                    color: active ? 'var(--ink-0)' : 'var(--ink-300)',
                  }}
                >
                  {PHASE_LABEL[phase]}
                </span>
              </li>
            );
          })}
        </ol>
      </Card>

      {/* Dashboard statistiche — valori dal server, MAI ricalcolati dal client. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          marginTop: 16,
        }}
      >
        <Stat label="Presenze" value={stats?.presenze ?? '—'} tone="normale" />
        <Stat
          label="Gettoni venduti"
          value={stats?.gettoni_venduti ?? '—'}
          tone="premium"
        />
        <Stat
          label="Ticket totali"
          value={stats?.ticket_totali ?? '—'}
          tone="gold"
        />
      </div>

      {statsError && (
        <p style={{ margin: '12px 0 0', color: 'var(--ember)', fontSize: 14 }}>
          Statistiche non disponibili: {statsError}
        </p>
      )}

      {/* Totem condiviso (demo isolato/sostituibile). level presentazionale. */}
      <Card style={{ marginTop: 16 }}>
        <p className="tag">Totem serata</p>
        <Totem level={2} />
      </Card>

      {/* Controlli — muta-stato, nessuna business logic nel client. */}
      <Card
        style={{
          marginTop: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <p className="tag">Fase serata — imposta</p>
        <div
          role="group"
          aria-label="Imposta fase"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
        >
          {PHASES.map((phase) => {
            const key = 'phase:' + phase;
            const isActive = phase === currentPhase;
            return (
              <div key={phase} style={{ flex: '1 1 30%', minWidth: 120 }}>
                <Button
                  variant={isActive ? 'primary' : 'ghost'}
                  disabled={!eventId || busyAction !== null}
                  onClick={() => handleSetPhase(phase)}
                >
                  {busyAction === key ? '…' : PHASE_LABEL[phase]}
                </Button>
              </div>
            );
          })}
        </div>

        <p className="tag" style={{ marginTop: 4 }}>Azioni</p>
        <Button
          variant="primary"
          disabled={!eventId || busyAction !== null}
          onClick={handleStartSession}
        >
          {busyAction === 'session' ? 'Lancio…' : 'Lancia sessione 30s'}
        </Button>
        <Button
          variant="ghost"
          disabled={!eventId || busyAction !== null}
          onClick={handleDraw}
        >
          {busyAction === 'draw' ? 'Estrazione…' : 'Estrai (3 vincitori)'}
        </Button>

        {actionError && (
          <p style={{ margin: '4px 0 0', color: 'var(--ember)', fontSize: 14 }}>
            {actionError}
          </p>
        )}
        {feedback && (
          <p style={{ margin: '4px 0 0', color: 'var(--eden-lavender)', fontSize: 14 }}>
            {feedback}
          </p>
        )}
      </Card>
    </Screen>
  );
}
