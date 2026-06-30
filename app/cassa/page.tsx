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
import { getCurrentEventId, getCurrentEventState } from '@/lib/events';
import { useGuestState } from '@/lib/useGuestState';
import { USE_API } from '@/lib/backend-mode';
import {
  staffSignIn,
  getSessionRole,
  isStaffRole,
  signOut,
} from '@/lib/auth';
import { lookupGuestByPin, topup, consume, listDrinks, RpcError } from '@/lib/rpc';
import type { TipoConsumazione, DrinkRow } from '@/lib/rpc';

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

// Estrae in modo DIFENSIVO l'esito ricco dal valore restituito dalla RPC consume
// (riga public.transactions: tipo_consumazione + ticket_delta). Il wrapper tipizza il
// ritorno come `unknown` e il path /api potrebbe non restituire la riga: qui leggo i
// campi solo se presenti e del tipo atteso, altrimenti null. NESSUN calcolo: sono i
// valori scritti dal DB, non derivati a mano.
function extractConsumeEsito(res: unknown): {
  tipo: TipoConsumazione | null;
  ticket: number | null;
} {
  // La RPC ritorna una singola riga, ma il path /api potrebbe wrapparla in array.
  const row = (Array.isArray(res) ? res[0] : res) as Record<string, unknown> | null;
  if (!row || typeof row !== 'object') return { tipo: null, ticket: null };
  const rawTipo = row.tipo_consumazione;
  const tipo: TipoConsumazione | null =
    rawTipo === 'normale' || rawTipo === 'premium' ? rawTipo : null;
  const rawTicket = row.ticket_delta;
  const ticket = typeof rawTicket === 'number' ? rawTicket : null;
  return { tipo, ticket };
}

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
  // Evento corrente risolto durante il lookup: lo TENGO in stato (oltre a usarlo
  // localmente in handleLookup) così l'useEffect del listino drink ha una chiave su cui
  // ri-fetchare. Resta deploy a evento singolo: lo ricavo da getCurrentEventId, non a mano.
  const [eventId, setEventId] = useState<string | null>(null);

  // Fase dell'evento (autoritativa dal DB via getCurrentEventState): SOLO per il gating
  // UX. Il gate reale resta server-side — le RPC topup/consume rifiutano comunque fuori
  // da APERTA (vedi raise 'ricariche disabilitate'/'bar non operativo' nello schema). Qui
  // disabilitiamo i bottoni in anticipo per evitare tentativi inutili e dare un messaggio.
  const [fase, setFase] = useState<string | null>(null);
  // Gating UX: blocco i bottoni SOLO quando conosco una fase ≠ APERTA. Con fase ancora
  // null (non risolta / non leggibile) NON blocco: il gate autoritativo resta la RPC
  // (rifiuta fuori da APERTA), quindi un blocco ottimistico su null negherebbe operazioni
  // legittime senza guadagno di sicurezza.
  const barChiuso = fase !== null && fase !== 'APERTA';
  const barOperativo = !barChiuso;

  // ── Fase E — ricarica ───────────────────────────────────────────────────
  const [tipo, setTipo] = useState<TipoConsumazione>('normale');
  const [qta, setQta] = useState<number>(1);
  const [importo, setImporto] = useState<number>(0);
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupError, setTopupError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // ── Fase F — consumo al bar (§7.3) ──────────────────────────────────────
  // Listino drink dell'evento (sola lettura, popolato via listDrinks): nessun
  // calcolo client. Il drink scelto guida il consumo; il tipo è già nella DrinkRow,
  // quindi NON serve scegliere normale/premium qui (lo fa il drink).
  const [drinks, setDrinks] = useState<DrinkRow[]>([]);
  const [drinkSelezionato, setDrinkSelezionato] = useState<string | null>(null);
  const [consumeBusy, setConsumeBusy] = useState(false);
  const [consumeError, setConsumeError] = useState<string | null>(null);
  const [consumeFeedback, setConsumeFeedback] = useState<string | null>(null);
  // Esito ricco dell'ultimo consumo, ricavato dal valore restituito dalla RPC consume
  // (riga transactions): il tipo consumato e i ticket assegnati (ticket_delta). NON è un
  // calcolo client: sono i valori scritti dal DB. Il nuovo saldo del tipo NON è nel
  // ritorno → lo leggo dal saldo vivo di useGuestState (sotto), mai ricalcolato a mano.
  const [consumeEsito, setConsumeEsito] = useState<{
    tipo: TipoConsumazione | null;
    ticket: number | null;
  } | null>(null);

  // p_idem STABILE per il consumo in corso (gemello di idemRef del topup): generato alla
  // scelta del drink e RIUSATO finché il consumo non va a buon fine. Un doppio-tap / retry
  // di rete ritenta con lo STESSO idem → la RPC ritorna la consumazione già scritta, NON
  // scala due volte il saldo. Azzerato su: (i) successo, (ii) cambio drink, (iii) cambio
  // ospite / resetGuest. NB: lo schema vuole p_idem di tipo uuid → randomUUID().
  const consumeIdemRef = useRef<string | null>(null);

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

  // Listino diviso in due sezioni per il picker: "Normali" e "Premium", raggruppando per
  // d.tipo. `drinks` arriva già ordinato per `ordine` da listDrinks (lato DB/wrapper): il
  // filter PRESERVA quell'ordine, quindi ogni sezione resta ordinata per ordine. NESSUN
  // ricalcolo di dominio: è solo una partizione presentazionale della lista server.
  const drinksNormali = useMemo(
    () => drinks.filter((d) => d.tipo === 'normale'),
    [drinks],
  );
  const drinksPremium = useMemo(
    () => drinks.filter((d) => d.tipo === 'premium'),
    [drinks],
  );

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

  // Carica il listino drink quando conosco l'evento (ricavato nel flusso lookup) e, su
  // path USE_API, lo tiene VIVO via SSE. listDrinks filtra già attivo=true e ordina per
  // `ordine` lato wrapper: qui mi limito a popolare lo stato (sola lettura). Niente evento
  // → svuoto il listino.
  //
  // REALTIME (solo USE_API, simmetria con regia/useGuestState): apro EventSource su
  // '/api/stream/drinks?event=<id>'. L'evento SSE 'drinks' è un puro SEGNALE "qualcosa è
  // cambiato" (nessun dato di catalogo nel payload): alla ricezione RILEGGO la lista via
  // listDrinks (refetch autoritativo RLS-scoped). Sul path supabase (o EventSource non
  // disponibile) resta solo il fetch iniziale, senza polling.
  useEffect(() => {
    if (!eventId) {
      setDrinks([]);
      return;
    }
    let active = true;

    const refetchDrinks = async () => {
      try {
        const rows = await listDrinks(supabase, { eventId });
        if (active) setDrinks(rows);
      } catch {
        // Listino non disponibile: lascio drinks vuoto → il picker mostra lo stato vuoto.
        if (active) setDrinks([]);
      }
    };

    // Fetch iniziale (entrambi i path).
    void refetchDrinks();

    // Realtime via SSE solo sul backend nuovo.
    if (USE_API && typeof EventSource !== 'undefined') {
      let es: EventSource | null = null;
      try {
        es = new EventSource(
          '/api/stream/drinks?event=' + encodeURIComponent(eventId),
          { withCredentials: true },
        );
      } catch {
        es = null;
      }

      if (es) {
        // 'drinks' = segnale → rileggi il listino (mai dati nel payload).
        const onDrinks = () => {
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
      // EventSource non costruibile: resta il solo fetch iniziale.
    }

    return () => {
      active = false;
    };
  }, [supabase, eventId]);

  // Fase dell'evento corrente (autoritativa dal DB) per il gating UX. Risolta quando
  // conosco l'evento (cioè al lookup / cambio ospite). È best-effort: la fase è gestita
  // dalla regia e qui non la sottoscriviamo in realtime, quindi il valore può restare
  // momentaneamente indietro rispetto a un cambio fase fatto altrove. Va bene: il gate
  // AUTORITATIVO resta comunque server-side nelle RPC (rifiutano fuori da APERTA), questo
  // è solo per disabilitare i bottoni e dare un messaggio. Niente polling aggiuntivo qui.
  useEffect(() => {
    if (!eventId) {
      setFase(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const st = await getCurrentEventState(supabase);
        if (active) setFase(st?.fase ?? null);
      } catch {
        // Fase non leggibile: lascio null → il gating resta prudente (vedi nota sotto) ma
        // le RPC restano la difesa reale.
        if (active) setFase(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [supabase, eventId]);

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
      const currentEventId = await getCurrentEventId(supabase);
      if (!currentEventId) {
        setLookupError('Nessun evento attivo');
        return;
      }
      // Conservo l'evento in stato: serve all'useEffect del listino drink.
      setEventId(currentEventId);
      const g = await lookupGuestByPin(supabase, currentEventId, pin);
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
    // Reset del pannello consumo (il listino drink resta: è dell'evento, non dell'ospite).
    setDrinkSelezionato(null);
    setConsumeError(null);
    setConsumeFeedback(null);
    setConsumeEsito(null);
    consumeIdemRef.current = null; // nuovo ospite → nuova idem al prossimo consumo
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

  // Scelta drink: imposta il drink e (ri)genera l'idem stabile del consumo. Cambiare drink
  // INVALIDA l'idem in attesa — un retry NON deve mai applicare un consumo a un drink diverso.
  function selectDrink(drinkId: string) {
    setDrinkSelezionato(drinkId);
    setConsumeError(null);
    setConsumeFeedback(null);
    setConsumeEsito(null);
    consumeIdemRef.current = crypto.randomUUID();
  }

  async function handleConsume(e: React.FormEvent) {
    e.preventDefault();
    if (!guestId || !drinkSelezionato) return;
    setConsumeBusy(true);
    setConsumeError(null);
    setConsumeFeedback(null);
    // p_idem STABILE per questo consumo: generato alla scelta del drink e riusato finché non
    // va a buon fine. Un retry (doppio tap / errore di rete) ritenta con lo STESSO idem → la
    // RPC ritorna la consumazione già scritta, NON scala due volte il saldo.
    if (!consumeIdemRef.current) consumeIdemRef.current = crypto.randomUUID();
    try {
      const res = await consume(supabase, {
        guestId,
        drinkId: drinkSelezionato,
        idem: consumeIdemRef.current,
      });
      // Successo: butta via l'idem e deseleziona così il prossimo consumo parte pulito.
      consumeIdemRef.current = null;
      setDrinkSelezionato(null);
      // NON tocco i saldi: useGuestState li riallinea via realtime/refetch.
      setConsumeFeedback('Consumo registrato');
      // Feedback ricco dal VALORE RESTITUITO dalla RPC (riga transactions): leggo il tipo
      // consumato e i ticket assegnati (ticket_delta). Lettura difensiva: la firma del
      // wrapper è `unknown` e il path /api potrebbe non restituire la riga → in tal caso
      // i campi restano null e mostro solo il saldo vivo (mai un calcolo a mano).
      setConsumeEsito(extractConsumeEsito(res));
    } catch (err) {
      // Errore → MANTENGO consumeIdemRef.current: ritentare lo stesso consumo è sicuro.
      if (err instanceof RpcError) {
        setConsumeError(err.message);
      } else {
        setConsumeError(err instanceof Error ? err.message : 'Errore consumo');
      }
    } finally {
      setConsumeBusy(false);
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

          {/* Gating fase (UX): se l'evento NON è APERTA segnalo che il bar non opera e
              disabilito i bottoni topup/consume sotto. Il gate AUTORITATIVO resta lato
              server (le RPC rifiutano comunque fuori da APERTA). */}
          {barChiuso && (
            <Card style={{ marginTop: 16, borderColor: 'var(--ember)' }}>
              <p className="tag" style={{ margin: 0 }}>Fase {fase}</p>
              <p style={{ margin: '6px 0 0', color: 'var(--ink-300)', fontSize: 14 }}>
                Bar operativo solo in APERTA — ricariche e consumi sono disabilitati.
              </p>
            </Card>
          )}

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

              {/* Gating UX: fuori da APERTA disabilito + spiego perché (il gate reale è
                  comunque server-side nella RPC topup). */}
              {barChiuso && (
                <p style={{ margin: '12px 0 0', color: 'var(--ember)', fontSize: 14 }}>
                  Bar operativo solo in APERTA.
                </p>
              )}

              <div style={{ marginTop: 16 }}>
                <Button type="submit" disabled={topupBusy || !barOperativo}>
                  {topupBusy ? 'Registrazione…' : 'Conferma ricarica'}
                </Button>
              </div>
            </form>
          </Card>

          {/* ── Fase F — pannello Consuma (§7.3) ───────────────────────────── */}
          <Card style={{ marginTop: 16 }}>
            <p className="tag" style={{ margin: 0 }}>Consuma — §7.3</p>
            <p style={{ margin: '6px 0 12px', color: 'var(--ink-300)', fontSize: 14 }}>
              Seleziona il drink dal listino: il saldo del tipo corrispondente scala
              di 1 (bloccato se a 0). Il saldo aggiornato arriva dal server.
            </p>

            <form onSubmit={handleConsume}>
              {/* Listino in DUE sezioni raggruppate per tipo: "Normali" e "Premium".
                  Ogni sezione è ordinata per `ordine` (eredita l'ordinamento di
                  listDrinks). I bottoni sono disabilitati fuori da APERTA (gate UX). */}
              {drinks.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--ink-300)', fontSize: 14 }}>
                  Nessun drink disponibile.
                </p>
              ) : (
                <>
                  <p className="tag" style={labelStyle}>Normali</p>
                  {drinksNormali.length === 0 ? (
                    <p style={{ margin: 0, color: 'var(--ink-300)', fontSize: 14 }}>
                      Nessun drink normale.
                    </p>
                  ) : (
                    <div
                      role="radiogroup"
                      aria-label="Drink normali da consumare"
                      style={{ display: 'grid', gap: 8 }}
                    >
                      {drinksNormali.map((d) => (
                        <Button
                          key={d.id}
                          variant={drinkSelezionato === d.id ? 'primary' : 'ghost'}
                          disabled={!barOperativo}
                          onClick={() => selectDrink(d.id)}
                        >
                          {d.nome}
                        </Button>
                      ))}
                    </div>
                  )}

                  <p className="tag" style={{ ...labelStyle, marginTop: 16 }}>
                    Premium
                  </p>
                  {drinksPremium.length === 0 ? (
                    <p style={{ margin: 0, color: 'var(--ink-300)', fontSize: 14 }}>
                      Nessun drink premium.
                    </p>
                  ) : (
                    <div
                      role="radiogroup"
                      aria-label="Drink premium da consumare"
                      style={{ display: 'grid', gap: 8 }}
                    >
                      {drinksPremium.map((d) => (
                        <Button
                          key={d.id}
                          variant={drinkSelezionato === d.id ? 'primary' : 'ghost'}
                          disabled={!barOperativo}
                          onClick={() => selectDrink(d.id)}
                        >
                          {d.nome}
                        </Button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {consumeError && (
                <p style={{ margin: '12px 0 0', color: 'var(--ember)', fontSize: 14 }}>
                  {consumeError}
                </p>
              )}
              {consumeFeedback && (
                <div style={{ margin: '12px 0 0' }}>
                  <p
                    style={{
                      margin: 0,
                      color: 'var(--eden-lavender)',
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                  >
                    {consumeFeedback}
                  </p>
                  {/* Esito ricco: ticket assegnati dal valore RESTITUITO dalla RPC
                      (ticket_delta) + nuovo saldo del tipo consumato dal saldo VIVO di
                      useGuestState (mai ricalcolato a mano). Mostro ogni riga solo se il
                      dato è disponibile. */}
                  {consumeEsito?.ticket != null && (
                    <p style={{ margin: '4px 0 0', color: 'var(--ink-300)', fontSize: 14 }}>
                      Ticket assegnati: <strong>{consumeEsito.ticket}</strong>
                    </p>
                  )}
                  {consumeEsito?.tipo != null && (
                    <p style={{ margin: '4px 0 0', color: 'var(--ink-300)', fontSize: 14 }}>
                      Nuovo saldo {consumeEsito.tipo}:{' '}
                      <strong>
                        {(consumeEsito.tipo === 'normale'
                          ? guest.saldoNormale
                          : guest.saldoPremium) ?? '—'}
                      </strong>
                    </p>
                  )}
                </div>
              )}

              {/* Gating UX: fuori da APERTA disabilito (il gate reale è server-side). */}
              {barChiuso && (
                <p style={{ margin: '12px 0 0', color: 'var(--ember)', fontSize: 14 }}>
                  Bar operativo solo in APERTA.
                </p>
              )}

              <div style={{ marginTop: 16 }}>
                <Button
                  type="submit"
                  disabled={consumeBusy || !drinkSelezionato || !barOperativo}
                >
                  {consumeBusy ? 'Registrazione…' : 'Conferma consumo'}
                </Button>
              </div>
            </form>
          </Card>
        </>
      )}
    </Screen>
  );
}
