// TEMP — swappabile quando arriva il design (Claude Design).
// Schermata CASSA (staff) — §10 checklist UI · §7.2 ricarica · §7.3 consumo.
// Flow cablato (M1-S3): login staff → lookup ospite per PIN → ricarica via RPC topup.
// VINCOLI: il front-end NON ricalcola MAI saldi/ticket. Legge i guest via RLS staff
// (SELECT diretta per il lookup; useGuestState per i saldi vivi) e SCRIVE solo via RPC.
// Logica isolata in lib/auth.ts + lib/rpc.ts: la pagina resta sostituibile col design
// definitivo senza toccare i wrapper.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Screen, Card, Button, Stat } from '@/components/ui';
import Totem from '@/components/Totem';
import { createClient } from '@/lib/supabase/client';
import { getCurrentEventId } from '@/lib/events';
import { useGuestState } from '@/lib/useGuestState';
import {
  staffSignIn,
  getSessionRole,
  isStaffRole,
  signOut,
} from '@/lib/auth';
import { lookupGuestByPin, topup, RpcError } from '@/lib/rpc';
import type { TipoConsumazione } from '@/lib/rpc';

// Stile condiviso degli input (token CSS, niente hex hardcoded).
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

export default function CassaPage() {
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

  // ── Fase C — lookup ospite per PIN ──────────────────────────────────────
  const [pin, setPin] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [guestId, setGuestId] = useState<string | null>(null);
  const [guestNome, setGuestNome] = useState<string | null>(null);

  // ── Fase E — ricarica ───────────────────────────────────────────────────
  const [tipo, setTipo] = useState<TipoConsumazione>('normale');
  const [qta, setQta] = useState<number>(1);
  const [importo, setImporto] = useState<number>(0);
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupError, setTopupError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // p_idem STABILE per la ricarica in corso: generato una volta e RIUSATO finché la
  // ricarica non va a buon fine. Così un doppio-submit (StrictMode, doppio tap, retry
  // di rete) ritenta con lo STESSO idem → la RPC ritorna la tx già scritta, NON
  // raddoppia il saldo. Rigenerato dopo un successo (nuova ricarica = nuovo idem) e
  // azzerato al cambio ospite. NB: lo schema vuole p_idem di tipo uuid → randomUUID().
  const idemRef = useRef<string | null>(null);

  // Saldi VIVI dell'ospite selezionato (fetch + realtime, sola lettura).
  // I valori arrivano dal DB: MAI calcolati qui. Dopo un topup non incremento
  // a mano → l'hook si riallinea via realtime/refetch (unico punto di verità).
  const guest = useGuestState(guestId);

  // Gate iniziale: leggi il ruolo della sessione (se esiste) al mount.
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

  const staff = isStaffRole(role);

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await staffSignIn(supabase, email, password);
      // Login riuscito ≠ è staff: ricontrollo esplicito del ruolo.
      const r = await getSessionRole(supabase);
      if (isStaffRole(r)) {
        setRole(r);
        setPassword('');
      } else {
        // Non lasciare appesa una sessione non-staff.
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
    setFeedback(null);
    setTopupError(null);
    try {
      const eventId = await getCurrentEventId(supabase);
      if (!eventId) {
        setLookupError('Nessun evento attivo');
        return;
      }
      const g = await lookupGuestByPin(supabase, eventId, pin);
      if (!g) {
        setLookupError('Ospite non trovato');
        setGuestId(null);
        setGuestNome(null);
        return;
      }
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
    setFeedback(null);
    setTopupError(null);
    setQta(1);
    setImporto(0);
    setTipo('normale');
    idemRef.current = null; // nuovo ospite → nuova idem alla prossima conferma
  }

  async function handleEsci() {
    await signOut(supabase);
    setRole(null);
    resetGuest();
    setEmail('');
    setPassword('');
  }

  async function handleTopup(e: React.FormEvent) {
    e.preventDefault();
    if (!guestId) return;
    // Validazione client minima (gating reale = server-side via RPC/RLS).
    if (!Number.isFinite(qta) || qta < 1) {
      setTopupError('Quantità minima 1');
      return;
    }
    if (!Number.isFinite(importo) || importo < 0) {
      setTopupError('Importo non valido');
      return;
    }
    setTopupBusy(true);
    setTopupError(null);
    setFeedback(null);
    // p_idem STABILE per questa conferma: generato una volta e riusato finché non va a
    // buon fine. Un retry (doppio submit / errore di rete) ritenta con lo STESSO idem →
    // la RPC ritorna la tx già scritta, NON raddoppia il saldo.
    if (!idemRef.current) idemRef.current = crypto.randomUUID();
    try {
      await topup(supabase, { guestId, tipo, qta, importo, idem: idemRef.current });
      // Successo: butta via l'idem così la PROSSIMA ricarica ne genera uno nuovo.
      idemRef.current = null;
      // NON tocco i saldi: useGuestState li riallinea via realtime/refetch.
      setFeedback('Ricarica registrata');
      setQta(1);
      setImporto(0);
    } catch (err) {
      // Errore → MANTENGO idemRef.current: ritentare la stessa conferma è sicuro.
      if (err instanceof RpcError) {
        setTopupError(err.message);
      } else {
        setTopupError(err instanceof Error ? err.message : 'Errore ricarica');
      }
    } finally {
      setTopupBusy(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Fase A — verifica accesso in corso.
  if (!roleChecked) {
    return (
      <Screen kicker="Postazione staff" title="Cassa">
        <Card>
          <p style={{ margin: 0, color: 'var(--ink-300)', fontSize: 14 }}>
            Verifica accesso…
          </p>
        </Card>
      </Screen>
    );
  }

  // Fase B — non staff → form login.
  if (!staff) {
    return (
      <Screen kicker="Postazione staff" title="Cassa">
        <Card style={{ borderColor: 'var(--ember)' }}>
          <p className="tag" style={{ margin: 0 }}>Solo operatori cassa</p>
          <p style={{ margin: '6px 0 0', color: 'var(--ink-300)', fontSize: 14 }}>
            Accedi con le credenziali staff. Le operazioni muovono saldi e ticket
            solo via funzioni server (RPC).
          </p>
        </Card>

        <Card style={{ marginTop: 16 }}>
          <form onSubmit={handleLogin}>
            <label htmlFor="cassa-email" className="tag" style={labelStyle}>
              Email staff
            </label>
            <input
              id="cassa-email"
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="operatore@evento.it"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />

            <label
              htmlFor="cassa-password"
              className="tag"
              style={{ ...labelStyle, marginTop: 12 }}
            >
              Password
            </label>
            <input
              id="cassa-password"
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

  // Fase C/D/E — staff loggato.
  return (
    <Screen kicker="Postazione staff" title="Cassa">
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
            <p className="tag" style={{ margin: 0 }}>Operatore cassa</p>
            <p style={{ margin: '6px 0 0', color: 'var(--ink-300)', fontSize: 14 }}>
              Ruolo: {role}. L&apos;app non sostituisce il controllo dell&apos;età.
            </p>
          </div>
          <div style={{ width: 120, flexShrink: 0 }}>
            <Button variant="ghost" onClick={handleEsci}>
              Esci
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Fase C — lookup ospite per PIN ───────────────────────────────── */}
      {!guestId ? (
        <Card style={{ marginTop: 16 }}>
          <form onSubmit={handleLookup}>
            <label htmlFor="cassa-pin" className="tag" style={labelStyle}>
              PIN ospite (4 cifre)
            </label>
            <input
              id="cassa-pin"
              type="text"
              inputMode="numeric"
              pattern="\d*"
              maxLength={4}
              autoComplete="off"
              placeholder="0000"
              value={pin}
              onChange={(e) =>
                setPin(e.target.value.replace(/\D/g, '').slice(0, 4))
              }
              style={inputStyle}
            />

            {lookupError && (
              <p style={{ margin: '12px 0 0', color: 'var(--ember)', fontSize: 14 }}>
                {lookupError}
              </p>
            )}

            <div style={{ marginTop: 16 }}>
              <Button type="submit" disabled={lookupBusy || pin.length !== 4}>
                {lookupBusy ? 'Ricerca…' : 'Trova ospite'}
              </Button>
            </div>
          </form>

          <div style={{ marginTop: 12 }}>
            {/* TODO(M2): apertura scanner QR → estrai PIN → stesso lookup. */}
            <Button variant="ghost" disabled>
              Scansiona QR ospite (in arrivo)
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {/* ── Fase D — ospite selezionato: Totem + saldi (re-fetch, no calcolo) ── */}
          <Card style={{ marginTop: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div>
                <p className="tag" style={{ margin: 0 }}>Ospite</p>
                <p
                  style={{
                    margin: '6px 0 0',
                    color: 'var(--ink-0)',
                    fontSize: 18,
                    fontWeight: 700,
                  }}
                >
                  {guest.nome ?? guestNome ?? '—'}
                </p>
              </div>
              <div style={{ width: 140, flexShrink: 0 }}>
                <Button variant="ghost" onClick={resetGuest}>
                  Cambia ospite
                </Button>
              </div>
            </div>
          </Card>

          <div
            style={{ display: 'flex', justifyContent: 'center', margin: '20px 0 8px' }}
          >
            <Totem level={guest.livelloTotem ?? 0} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Stat
              label="Saldo normali"
              value={guest.saldoNormale ?? '—'}
              tone="normale"
            />
            <Stat
              label="Saldo premium"
              value={guest.saldoPremium ?? '—'}
              tone="premium"
            />
          </div>

          {guest.error && (
            <p style={{ margin: '12px 0 0', color: 'var(--ember)', fontSize: 14 }}>
              Saldi non disponibili: {guest.error.message}
            </p>
          )}

          {/* ── Fase E — pannello Ricarica (§7.2) ──────────────────────────── */}
          <Card style={{ marginTop: 16 }}>
            <p className="tag" style={{ margin: 0 }}>Ricarica — §7.2</p>
            <p style={{ margin: '6px 0 12px', color: 'var(--ink-300)', fontSize: 14 }}>
              Scegli tipo e quantità, registra l&apos;incasso, poi conferma. Il
              saldo aggiornato arriva dal server.
            </p>

            <form onSubmit={handleTopup}>
              <p className="tag" style={labelStyle}>Tipo</p>
              <div
                role="group"
                aria-label="Tipo ricarica"
                style={{ display: 'flex', gap: 12 }}
              >
                <Button
                  variant={tipo === 'normale' ? 'primary' : 'ghost'}
                  onClick={() => {
                    idemRef.current = null; // cambio tipo → nuova idem
                    setTipo('normale');
                  }}
                >
                  Normale
                </Button>
                <Button
                  variant={tipo === 'premium' ? 'primary' : 'ghost'}
                  onClick={() => {
                    idemRef.current = null;
                    setTipo('premium');
                  }}
                >
                  Premium
                </Button>
              </div>

              <label
                htmlFor="cassa-qta"
                className="tag"
                style={{ ...labelStyle, marginTop: 16 }}
              >
                Quantità
              </label>
              <input
                id="cassa-qta"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={qta}
                onChange={(e) => {
                  // Cambio parametri della ricarica → invalida l'idem in attesa:
                  // un retry NON deve riapplicare un importo/quantità ormai diversi.
                  idemRef.current = null;
                  setQta(parseInt(e.target.value, 10) || 0);
                }}
                style={inputStyle}
              />

              <label
                htmlFor="cassa-importo"
                className="tag"
                style={{ ...labelStyle, marginTop: 12 }}
              >
                Importo incassato (€)
              </label>
              <input
                id="cassa-importo"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={importo}
                onChange={(e) => {
                  idemRef.current = null; // vedi nota su quantità
                  setImporto(parseFloat(e.target.value) || 0);
                }}
                style={inputStyle}
              />

              {topupError && (
                <p style={{ margin: '12px 0 0', color: 'var(--ember)', fontSize: 14 }}>
                  {topupError}
                </p>
              )}
              {feedback && (
                <p
                  style={{
                    margin: '12px 0 0',
                    color: 'var(--eden-lavender)',
                    fontSize: 14,
                  }}
                >
                  {feedback}
                </p>
              )}

              <div style={{ marginTop: 16 }}>
                <Button type="submit" disabled={topupBusy}>
                  {topupBusy ? 'Registrazione…' : 'Conferma ricarica'}
                </Button>
              </div>
            </form>
          </Card>

          {/* ── Consuma — TODO(M2): nessun cablaggio consumo in M1-S3. ──────── */}
          <Card style={{ marginTop: 16 }}>
            <p className="tag" style={{ margin: 0 }}>Consuma — §7.3</p>
            <p style={{ margin: '6px 0 12px', color: 'var(--ink-300)', fontSize: 14 }}>
              Seleziona il drink dal listino: il saldo del tipo corrispondente scala
              di 1 (bloccato se a 0).
            </p>
            {/* TODO(M2 consume): transaction(consumo) → saldo--, ticket via RPC. */}
            <Button disabled>Conferma consumo (TODO M2)</Button>
          </Card>
        </>
      )}
    </Screen>
  );
}
