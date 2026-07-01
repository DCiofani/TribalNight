// Schermata CASSA (staff) — design Claude (C1–C5) implementato fedelmente.
// LOGICA INVARIATA: login staff → lookup ospite per PIN → topup/consume via RPC,
// con idempotenza (p_idem) e gating fase. Il front-end NON ricalcola MAI saldi/ticket.
// Unica differenza UX dal vecchio form: l'importo ricarica è calcolato da quantità ×
// prezzo dell'evento (il design non ha campo importo manuale). I prezzi NON sono più
// hardcoded: arrivano dal server (events.prezzo_normale/prezzo_premium via
// getCurrentEventState). Finché non sono caricati, la ricarica è disabilitata.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { getCurrentEventId, getCurrentEventState } from '@/lib/events';
import { useGuestState } from '@/lib/useGuestState';
import { USE_API } from '@/lib/backend-mode';
import { staffSignIn, getSessionRole, isStaffRole, signOut } from '@/lib/auth';
import { lookupGuestByPin, topup, consume, listDrinks, getLedger, RpcError } from '@/lib/rpc';
import type { TipoConsumazione, DrinkRow } from '@/lib/rpc';
import { CassaHome, CassaScan, CassaRicarica, CassaConsuma, CassaConferma, type DrinkTile } from '@/components/screens/CassaScreens';

const fmtEuro = (n: number) => `€ ${n.toFixed(2).replace('.', ',')}`;
const fmtInt = (n: number) => new Intl.NumberFormat('it-IT').format(n);

function extractConsumeEsito(res: unknown): { tipo: TipoConsumazione | null; ticket: number | null } {
  const row = (Array.isArray(res) ? res[0] : res) as Record<string, unknown> | null;
  if (!row || typeof row !== 'object') return { tipo: null, ticket: null };
  const rawTipo = row.tipo_consumazione;
  const tipo: TipoConsumazione | null = rawTipo === 'normale' || rawTipo === 'premium' ? rawTipo : null;
  const rawTicket = row.ticket_delta;
  const ticket = typeof rawTicket === 'number' ? rawTicket : null;
  return { tipo, ticket };
}

export default function CassaPage() {
  const supabase = useMemo(() => createClient(), []);

  // Fase A — gate ruolo
  const [role, setRole] = useState<string | null>(null);
  const [roleChecked, setRoleChecked] = useState(false);
  // Fase B — login staff
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // Mode (C1): quale azione lo staff ha scelto
  const [mode, setMode] = useState<'ricarica' | 'consuma' | null>(null);
  // Fase C — lookup ospite per PIN
  const [pin, setPin] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [guestId, setGuestId] = useState<string | null>(null);
  const [guestNome, setGuestNome] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  // Fase evento (gating UX; il gate reale è server-side nelle RPC)
  const [fase, setFase] = useState<string | null>(null);
  const barChiuso = fase !== null && fase !== 'APERTA';
  const barOperativo = !barChiuso;
  // Prezzi ricarica dell'evento (autoritativi dal server). null = non ancora caricati →
  // la ricarica resta disabilitata (non si inventano costanti lato client).
  const [prezzoNormale, setPrezzoNormale] = useState<number | null>(null);
  const [prezzoPremium, setPrezzoPremium] = useState<number | null>(null);
  // KPI home cassa (C1): totali REALI dell'evento via getLedger (la cassa è staff).
  // null = fetch non riuscito / non ancora disponibile → si mostra "—".
  const [kpiIncasso, setKpiIncasso] = useState<number | null>(null);
  const [kpiGettoni, setKpiGettoni] = useState<number | null>(null);
  // Ricarica
  const [tipo, setTipo] = useState<TipoConsumazione>('normale');
  const [qta, setQta] = useState<number>(1);
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupError, setTopupError] = useState<string | null>(null);
  // Prezzo del tipo selezionato (dal server). null finché non è caricato → ricarica disabilitata.
  const prezzoCorrente = tipo === 'premium' ? prezzoPremium : prezzoNormale;
  // Consumo
  const [drinks, setDrinks] = useState<DrinkRow[]>([]);
  const [drinkSelezionato, setDrinkSelezionato] = useState<string | null>(null);
  const [consumeBusy, setConsumeBusy] = useState(false);
  const [consumeError, setConsumeError] = useState<string | null>(null);
  const consumeIdemRef = useRef<string | null>(null);
  const idemRef = useRef<string | null>(null);

  const guest = useGuestState(guestId);

  // Gate iniziale: ruolo sessione.
  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await getSessionRole(supabase);
      if (!active) return;
      setRole(r);
      setRoleChecked(true);
    })();
    return () => { active = false; };
  }, [supabase]);

  const staff = isStaffRole(role);

  // Risolve l'evento corrente appena lo staff è autenticato: così la HOME (C1) carica
  // fase, prezzi e KPI (incasso/gettoni) senza attendere il lookup ospite. Il lookup
  // riconferma comunque lo stesso eventId.
  useEffect(() => {
    if (!staff) return;
    let active = true;
    void (async () => {
      try {
        const id = await getCurrentEventId(supabase);
        if (active && id) setEventId(id);
      } catch {
        /* resta null → prezzi/KPI mostrano "—", ricarica disabilitata */
      }
    })();
    return () => { active = false; };
  }, [staff, supabase]);

  // Listino drink dell'evento (+ realtime SSE su USE_API).
  useEffect(() => {
    if (!eventId) { setDrinks([]); return; }
    let active = true;
    const refetchDrinks = async () => {
      try {
        const rows = await listDrinks(supabase, { eventId });
        if (active) setDrinks(rows);
      } catch {
        if (active) setDrinks([]);
      }
    };
    void refetchDrinks();
    if (USE_API && typeof EventSource !== 'undefined') {
      let es: EventSource | null = null;
      try {
        es = new EventSource('/api/stream/drinks?event=' + encodeURIComponent(eventId), { withCredentials: true });
      } catch { es = null; }
      if (es) {
        const onDrinks = () => { if (active) void refetchDrinks(); };
        es.addEventListener('drinks', onDrinks as EventListener);
        return () => { active = false; es?.removeEventListener('drinks', onDrinks as EventListener); es?.close(); };
      }
    }
    return () => { active = false; };
  }, [supabase, eventId]);

  // Fase evento corrente (gating UX) + prezzi ricarica (autoritativi dal server).
  // Un solo getCurrentEventState fornisce fase e prezzi coerenti per lo stesso evento.
  useEffect(() => {
    if (!eventId) { setFase(null); setPrezzoNormale(null); setPrezzoPremium(null); return; }
    let active = true;
    void (async () => {
      try {
        const st = await getCurrentEventState(supabase);
        if (!active) return;
        setFase(st?.fase ?? null);
        setPrezzoNormale(st?.prezzo_normale ?? null);
        setPrezzoPremium(st?.prezzo_premium ?? null);
      } catch {
        if (active) { setFase(null); setPrezzoNormale(null); setPrezzoPremium(null); }
      }
    })();
    return () => { active = false; };
  }, [supabase, eventId]);

  // KPI home cassa (C1): totali REALI dell'evento via getLedger (la cassa è staff → RLS ok).
  // Non ricalcoliamo nulla nel client: incasso_euro e gettoni_emessi sono aggregati dal DB.
  // Se il fetch fallisce lasciamo null → la UI mostra "—".
  useEffect(() => {
    if (!eventId) { setKpiIncasso(null); setKpiGettoni(null); return; }
    let active = true;
    void (async () => {
      try {
        const ledger = await getLedger(supabase, { eventId });
        if (!active) return;
        setKpiIncasso(ledger.totali.incasso_euro);
        setKpiGettoni(ledger.totali.gettoni_emessi);
      } catch {
        if (active) { setKpiIncasso(null); setKpiGettoni(null); }
      }
    })();
    return () => { active = false; };
  }, [supabase, eventId]);

  // ── Handlers (logica invariata) ──
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await staffSignIn(supabase, email, password);
      const r = await getSessionRole(supabase);
      if (isStaffRole(r)) {
        setRole(r);
        setPassword('');
      } else {
        await signOut(supabase);
        setRole(null);
        setAuthError('Account senza permessi cassa');
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Credenziali non valide');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (pin.length !== 4) return;
    setLookupBusy(true);
    setLookupError(null);
    setTopupError(null);
    try {
      const currentEventId = await getCurrentEventId(supabase);
      if (!currentEventId) { setLookupError('Nessun evento attivo'); return; }
      setEventId(currentEventId);
      const g = await lookupGuestByPin(supabase, currentEventId, pin);
      if (!g) { setLookupError('Ospite non trovato'); setGuestId(null); setGuestNome(null); return; }
      setGuestId(g.id);
      setGuestNome(g.nome);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Errore nel lookup');
    } finally {
      setLookupBusy(false);
    }
  }

  function resetGuest() {
    setGuestId(null);
    setGuestNome(null);
    setPin('');
    setLookupError(null);
    setTopupError(null);
    setQta(1);
    setTipo('normale');
    idemRef.current = null;
    setDrinkSelezionato(null);
    setConsumeError(null);
    consumeIdemRef.current = null;
  }

  async function handleEsci() {
    await signOut(supabase);
    setRole(null);
    setMode(null);
    resetGuest();
    setEmail('');
    setPassword('');
  }

  async function handleTopup() {
    if (!guestId) return;
    if (!Number.isFinite(qta) || qta < 1) { setTopupError('Quantità minima 1'); return; }
    // Prezzo autoritativo dal server: se non è ancora caricato non inventiamo nulla, si attende.
    if (prezzoCorrente == null) { setTopupError('Prezzi non disponibili'); return; }
    // Importo = quantità × prezzo dell'evento (design C3, niente importo manuale).
    const importo = qta * prezzoCorrente;
    setTopupBusy(true);
    setTopupError(null);
    if (!idemRef.current) idemRef.current = crypto.randomUUID();
    try {
      await topup(supabase, { guestId, tipo, qta, importo, idem: idemRef.current });
      idemRef.current = null;
      setQta(1);
      resetGuest();
      setMode(null);
    } catch (err) {
      setTopupError(err instanceof RpcError ? err.message : err instanceof Error ? err.message : 'Errore ricarica');
    } finally {
      setTopupBusy(false);
    }
  }

  function selectDrink(drinkId: string) {
    setDrinkSelezionato(drinkId);
    setConsumeError(null);
    consumeIdemRef.current = crypto.randomUUID();
  }

  async function handleConsume() {
    if (!guestId || !drinkSelezionato) return;
    setConsumeBusy(true);
    setConsumeError(null);
    if (!consumeIdemRef.current) consumeIdemRef.current = crypto.randomUUID();
    try {
      const res = await consume(supabase, { guestId, drinkId: drinkSelezionato, idem: consumeIdemRef.current });
      consumeIdemRef.current = null;
      extractConsumeEsito(res); // esito (tipo/ticket) disponibile se servisse mostrarlo
      setDrinkSelezionato(null);
      resetGuest();
      setMode(null);
    } catch (err) {
      setConsumeError(err instanceof RpcError ? err.message : err instanceof Error ? err.message : 'Errore consumo');
    } finally {
      setConsumeBusy(false);
    }
  }

  // ── Render: flusso C1 → C2 → C3/C4 → C5 ──
  const dash = (v: number | null) => (v == null ? '—' : v);
  const guestSub = `${guest.saldoNormale ?? 0}N · ${guest.saldoPremium ?? 0}P`;

  // Fase A — loading
  if (!roleChecked) {
    return (
      <div style={{ minHeight: '100dvh', background: '#160C06', color: '#A58A66', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        Verifica accesso…
      </div>
    );
  }

  // Fase B — login staff (il design assume staff loggato; login coerente con la palette)
  if (!staff) {
    return (
      <div style={{ minHeight: '100dvh', background: 'radial-gradient(120% 80% at 50% 16%, #2C1B12 0%, #160C06 62%)', color: '#fff', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 24px', maxWidth: 440, margin: '0 auto' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, letterSpacing: '.04em', lineHeight: 0.95 }}>TOTEM NIGHT</div>
        <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.24em', fontSize: 11, color: '#D89A3E', marginTop: 8 }}>CASSA · STAFF</div>
        <form onSubmit={handleLogin} style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input type="email" inputMode="email" autoComplete="username" placeholder="operatore@evento.it" value={email} onChange={(e) => setEmail(e.target.value)}
            style={{ height: 54, borderRadius: 12, background: '#2A1A11', border: '1px solid #4A2D1C', padding: '0 16px', fontSize: 16, color: '#fff', fontFamily: 'var(--font-ui)', outline: 'none' }} />
          <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ height: 54, borderRadius: 12, background: '#2A1A11', border: '1px solid #4A2D1C', padding: '0 16px', fontSize: 16, color: '#fff', fontFamily: 'var(--font-ui)', outline: 'none' }} />
          {authError ? <div style={{ color: '#EE6321', fontSize: 14 }}>{authError}</div> : null}
          <button type="submit" disabled={authBusy} className="btn" style={{ height: 56, borderRadius: 14, background: '#3A5BBE', color: '#fff', border: 'none', fontWeight: 600, fontSize: 16, cursor: authBusy ? 'not-allowed' : 'pointer', opacity: authBusy ? 0.6 : 1, fontFamily: 'var(--font-ui)' }}>
            {authBusy ? 'Accesso…' : 'Accedi'}
          </button>
        </form>
      </div>
    );
  }

  // C1 — home: scegli azione
  if (!mode) {
    return (
      <CassaHome
        staffName={(role ?? 'STAFF').toUpperCase()}
        stato={fase ?? 'APERTA'}
        ricaricheOggi={kpiGettoni == null ? '—' : fmtInt(kpiGettoni)}
        incasso={kpiIncasso == null ? '—' : fmtEuro(kpiIncasso)}
        onRicarica={() => setMode('ricarica')}
        onConsuma={() => setMode('consuma')}
        onLogout={handleEsci}
      />
    );
  }

  // C2 — identifica ospite (PIN)
  if (!guestId) {
    const pinField = (
      <form onSubmit={handleLookup} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          inputMode="numeric"
          pattern="\d*"
          maxLength={4}
          autoComplete="off"
          placeholder="PIN ospite (4 cifre)"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          style={{ height: 54, borderRadius: 12, background: '#2A1A11', border: '1px solid #4A2D1C', padding: '0 16px', fontSize: 16, color: '#fff', fontFamily: 'var(--font-ui)', outline: 'none', letterSpacing: '.2em' }}
        />
        {lookupError ? <div style={{ color: '#EE6321', fontSize: 14 }}>{lookupError}</div> : null}
        <button type="submit" disabled={lookupBusy || pin.length !== 4} className="btn" style={{ height: 52, borderRadius: 12, background: '#3A5BBE', color: '#fff', border: 'none', fontWeight: 600, fontSize: 15, cursor: 'pointer', opacity: lookupBusy || pin.length !== 4 ? 0.5 : 1, fontFamily: 'var(--font-ui)' }}>
          {lookupBusy ? 'Ricerca…' : 'Trova ospite'}
        </button>
      </form>
    );
    return (
      <CassaScan
        title={mode === 'ricarica' ? 'RICARICA — CHI?' : 'CONSUMA — CHI?'}
        pinField={pinField}
        results={[]}
        onBack={() => { resetGuest(); setMode(null); }}
      />
    );
  }

  // C3 — ricarica
  if (mode === 'ricarica') {
    return (
      <>
        {topupError ? (
          <div style={{ position: 'fixed', top: 12, left: 0, right: 0, textAlign: 'center', color: '#EE6321', fontSize: 14, zIndex: 50 }}>{topupError}</div>
        ) : null}
        <CassaRicarica
        guestName={guest.nome ?? guestNome ?? ''}
        guestSub={guestSub}
        tipo={tipo === 'normale' ? 'NORMALE' : 'PREMIUM'}
        prezzoN={prezzoNormale == null ? '—' : fmtEuro(prezzoNormale)}
        prezzoP={prezzoPremium == null ? '—' : fmtEuro(prezzoPremium)}
        qty={qta}
        totale={prezzoCorrente == null ? '—' : fmtEuro(qta * prezzoCorrente)}
        onTipo={(t) => { idemRef.current = null; setTipo(t === 'NORMALE' ? 'normale' : 'premium'); }}
        onDec={() => { idemRef.current = null; setQta((q) => Math.max(1, q - 1)); }}
        onInc={() => { idemRef.current = null; setQta((q) => q + 1); }}
        onConfirm={() => { if (barOperativo && !topupBusy && prezzoCorrente != null) void handleTopup(); }}
        onBack={resetGuest}
        />
      </>
    );
  }

  // C4 — consuma (listino) + C5 — conferma
  const selDrink = drinks.find((d) => d.id === drinkSelezionato);
  if (selDrink) {
    return (
      <CassaConferma
        drinkName={selDrink.nome}
        guestName={guest.nome ?? guestNome ?? ''}
        tag={selDrink.tipo === 'premium' ? '1 PREMIUM' : '1 NORMALE'}
        tagColor={selDrink.tipo === 'premium' ? '#9BB6EC' : '#D8C3A6'}
        ticketLine="IL TOTEM CRESCE"
        onConfirm={() => { if (!consumeBusy) void handleConsume(); }}
        onCancel={() => setDrinkSelezionato(null)}
      />
    );
  }
  const tiles: DrinkTile[] = drinks.map((d) => {
    const avail = (d.tipo === 'premium' ? guest.saldoPremium : guest.saldoNormale) ?? 0;
    const locked = avail <= 0 || !barOperativo;
    return {
      name: d.nome,
      tag: d.tipo === 'premium' ? 'PREMIUM' : 'NORMALE',
      tagColor: d.tipo === 'premium' ? '#9BB6EC' : '#D8C3A6',
      border: d.tipo === 'premium' ? '#5E83CE66' : '#43291A',
      opacity: locked ? 0.45 : 1,
      lock: locked ? '🔒' : '',
    };
  });
  return (
    <>
      {consumeError ? (
        <div style={{ position: 'fixed', top: 12, left: 0, right: 0, textAlign: 'center', color: '#EE6321', fontSize: 14, zIndex: 50 }}>{consumeError}</div>
      ) : null}
      <CassaConsuma
        guestName={(guest.nome ?? guestNome ?? '').toString()}
        normali={dash(guest.saldoNormale)}
        premium={dash(guest.saldoPremium)}
        tiles={tiles}
        onBack={resetGuest}
        onPick={(i) => {
          const d = drinks[i];
          const avail = (d.tipo === 'premium' ? guest.saldoPremium : guest.saldoNormale) ?? 0;
          if (avail > 0 && barOperativo) selectDrink(d.id);
        }}
      />
    </>
  );
}
