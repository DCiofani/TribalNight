// TEMP — swappabile quando arriva il design (Claude Design).
//
// Schermata OSPITE (spec §10).
// PRESENTAZIONE isolata dalla logica: usa solo i primitivi UI e il Totem.
// Cablaggio M1-S3: dati LIVE da public.guests via useGuestState (RLS + Realtime).
// Cablaggio guest-menu: MENÙ REALE dal catalogo `drinks` (sole voci visibili) +
// reazione alla FASE dell'evento. Il front-end NON calcola MAI saldi/ticket/livello/
// stato: legge la riga/lista/fase dal backend e basta.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Screen, Card, Button, Stat } from '@/components/ui';
import Totem from '@/components/Totem';
import { loadGuestId } from '@/lib/guest-session';
import { useGuestState } from '@/lib/useGuestState';
import { createClient } from '@/lib/supabase/client';
import { listVisibleDrinks, type DrinkRow } from '@/lib/rpc';
import { getCurrentEventState } from '@/lib/events';
import { USE_API } from '@/lib/backend-mode';

// Polling leggero del listino (sola lettura). Per l'OSPITE non possiamo usare lo
// stream SSE dei drink (/api/stream/drinks è gated requireRole cassa/regia/admin →
// 403 per un ospite): refresh periodico del menù è il meccanismo corretto e sicuro
// in entrambe le modalità (supabase / api). Intervallo blando: il menù cambia di rado.
const MENU_POLL_MS = 20000;

// Polling leggero della FASE come fallback: in USE_API la fase arriva in realtime
// dall'evento `phase` dell'EventSource del guest (stesso stream di useGuestState);
// in modalità supabase, o se l'EventSource non è disponibile, si rilegge la fase via
// getCurrentEventState con questo intervallo. La fase resta SEMPRE autoritativa dal DB.
const PHASE_POLL_MS = 15000;

// Etichetta leggibile del tipo di consumazione (presentazionale).
const TIPO_LABEL: Record<DrinkRow['tipo'], string> = {
  normale: 'Normale',
  premium: 'Premium',
};

// Copy del banner per fase non-APERTA. La fase NON viene mai ricalcolata: arriva dal
// server (getCurrentEventState / evento SSE `phase`). SETUP/APERTA non mostrano banner.
const PHASE_BANNER: Record<string, { titolo: string; testo: string }> = {
  LAST_CALL: {
    titolo: 'Last call',
    testo: 'Il bar è chiuso. È il momento di convertire il credito residuo in ticket.',
  },
  ESTRAZIONE: {
    titolo: 'Estrazione in corso',
    testo: 'Tieni pronto il tuo PIN: si estraggono i vincitori.',
  },
  CHIUSA: {
    titolo: 'Evento concluso',
    testo: 'Grazie per aver partecipato. Lo stato qui sotto è quello finale.',
  },
};

// Spezza il PIN in 4 caselle; "—" finché non c'è il valore.
function pinDigits(pin: string | null): string[] {
  const base = (pin ?? '').slice(0, 4).split('');
  while (base.length < 4) base.push('—');
  return base;
}

export default function GuestPage() {
  const router = useRouter();

  // guestId letto SOLO lato client (evita mismatch SSR): parte da undefined,
  // diventa string|null dopo il mount.
  const [guestId, setGuestId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const id = loadGuestId();
    if (!id) {
      // Ospite non registrato: torna all'onboarding.
      router.replace('/onboarding');
    }
    setGuestId(id);
  }, [router]);

  // Wallet (saldi/ticket/livello/PIN) — LIVE, sola lettura, invariato.
  const {
    pin,
    saldoNormale,
    saldoPremium,
    ticketTotali,
    livelloTotem,
    error,
  } = useGuestState(guestId ?? null);

  // ── Evento corrente: id + fase (autoritativi dal server) ──────────────────
  const [eventId, setEventId] = useState<string | null>(null);
  const [fase, setFase] = useState<string | null>(null);

  // ── Menù reale (sole voci visibili all'ospite) ────────────────────────────
  const [drinks, setDrinks] = useState<DrinkRow[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState(false);

  // Istanza supabase stabile per i wrapper (in API mode i wrapper non la usano,
  // ma la firma la richiede). useRef così non si ricrea ad ogni render.
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  if (supabaseRef.current === null) {
    supabaseRef.current = createClient();
  }

  // Refetch del listino: SOLA LETTURA via wrapper (branch USE_API già dentro).
  const refetchMenu = useCallback(
    async (evId: string, signal: () => boolean) => {
      try {
        const list = await listVisibleDrinks(supabaseRef.current!, { eventId: evId });
        if (!signal()) return;
        setDrinks(list);
        setMenuError(false);
        setMenuLoading(false);
      } catch {
        if (!signal()) return;
        setMenuError(true);
        setMenuLoading(false);
      }
    },
    [],
  );

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
      // Errore transitorio: non azzeriamo la fase nota; ritenta al prossimo giro.
    }
  }, []);

  // Effetto: risoluzione evento + caricamento menù + polling leggero del menù.
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

      if (!evId) {
        if (active) setMenuLoading(false);
        return;
      }

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
  //     È una connessione separata da quella di useGuestState (che non espone la
  //     fase): leggiamo solo l'evento `phase`, ignorando `state`. Fallback a polling
  //     se EventSource non è disponibile.
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
        // Solo l'evento `phase`: { fase } dal server. Niente refetch del wallet
        // qui (lo gestisce useGuestState sulla SUA connessione `state`).
        es.addEventListener('phase', (ev) => {
          if (!active) return;
          try {
            const data = JSON.parse((ev as MessageEvent).data) as { fase?: string };
            if (data?.fase) setFase(data.fase);
          } catch {
            // Payload inatteso: ignora, la fase nota resta valida.
          }
        });
        // Se lo stream cade, degrada al polling (la fase non deve restare stale).
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

  const pin4 = pinDigits(pin);
  const banner = fase ? PHASE_BANNER[fase] : undefined;
  const barChiuso = fase === 'LAST_CALL' || fase === 'ESTRAZIONE' || fase === 'CHIUSA';

  return (
    <Screen kicker="Ospite" title="Il tuo Totem">
      {/* Banner di FASE: appare per LAST_CALL / ESTRAZIONE / CHIUSA. Stato dal server. */}
      {banner && (
        <Card style={{ marginBottom: 12, borderColor: 'var(--ember)' }}>
          <p className="tag" style={{ marginBottom: 4 }}>
            {banner.titolo}
          </p>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-0)' }}>
            {banner.testo}
          </p>
        </Card>
      )}

      {/* Eroe centrale: livello autoritativo da livello_totem (DB), 0 in attesa. */}
      <Totem level={livelloTotem ?? 0} />

      {error && (
        <Card style={{ marginTop: 12, borderColor: 'var(--ember)' }}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-0)' }}>
            Impossibile caricare lo stato.
          </p>
        </Card>
      )}

      {/* Saldi: due tile affiancate (Normali / Premium). Solo lettura. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          marginTop: 8,
        }}
      >
        <Stat label="Saldo Normali" value={saldoNormale ?? '—'} tone="normale" />
        <Stat label="Saldo Premium" value={saldoPremium ?? '—'} tone="premium" />
      </div>

      {/* Ticket totali: tile a larghezza piena (GENERATED lato DB). */}
      <div style={{ marginTop: 12 }}>
        <Stat label="Ticket totali" value={ticketTotali ?? '—'} tone="normale" />
      </div>

      {/* Blocco "Mostra alla cassa": QR placeholder + PIN. */}
      <Card style={{ marginTop: 16 }}>
        <p className="tag">Mostra alla cassa</p>
        <h2 style={{ fontSize: 18, margin: '4px 0 12px' }}>Il tuo codice</h2>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          {/* QR firmato = TODO(M2/M3), fuori scope: resta placeholder. */}
          <div
            role="img"
            aria-label="Codice QR non ancora disponibile"
            style={{
              width: 180,
              height: 180,
              borderRadius: 12,
              border: '1px dashed var(--night-700)',
              background: 'var(--night-800)',
              color: 'var(--ink-300)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              fontSize: 13,
              padding: 12,
            }}
          >
            QR in arrivo
          </div>

          {/* PIN cassa: 4 caselle. Valore reale dalla propria riga (RLS-ok). */}
          <div style={{ width: '100%' }}>
            <p className="tag" style={{ marginBottom: 8 }}>
              PIN cassa
            </p>
            <div
              role="group"
              aria-label="PIN cassa"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 8,
              }}
            >
              {pin4.map((cifra, i) => (
                <div
                  key={i}
                  aria-hidden="true"
                  style={{
                    aspectRatio: '1 / 1',
                    borderRadius: 12,
                    border: '1px solid var(--night-700)',
                    background: 'var(--night-800)',
                    color: 'var(--ink-0)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 28,
                    fontWeight: 700,
                  }}
                >
                  {cifra}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Menù REALE: sole voci visibili all'ospite (listVisibleDrinks). Sola lettura. */}
      <section style={{ marginTop: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <p className="tag" style={{ margin: 0 }}>
            Menù
          </p>
          {barChiuso && (
            <span className="tag" style={{ color: 'var(--ember)' }}>
              Bar chiuso
            </span>
          )}
        </div>

        {menuLoading ? (
          <Card>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-300)' }}>
              Carico il menù…
            </p>
          </Card>
        ) : menuError ? (
          <Card style={{ borderColor: 'var(--ember)' }}>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-0)' }}>
              Impossibile caricare il menù.
            </p>
          </Card>
        ) : drinks.length === 0 ? (
          <Card>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-300)' }}>
              Nessuna voce disponibile al momento.
            </p>
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {drinks.map((d) => (
              <Card
                key={d.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  // In LAST_CALL/ESTRAZIONE/CHIUSA il bar è OFF: menù presentazionale
                  // attenuato (l'ospite converte il credito, non ordina). Stato dal server.
                  opacity: barChiuso ? 0.55 : 1,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: 'var(--ink-0)', fontWeight: 600 }}>{d.nome}</div>
                  {d.categoria && (
                    <div style={{ fontSize: 12, color: 'var(--ink-300)', marginTop: 2 }}>
                      {d.categoria}
                    </div>
                  )}
                  {d.descrizione && (
                    <div style={{ fontSize: 13, color: 'var(--ink-300)', marginTop: 4 }}>
                      {d.descrizione}
                    </div>
                  )}
                </div>
                <span className="tag" style={{ flexShrink: 0 }}>
                  {TIPO_LABEL[d.tipo]}
                </span>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Azione segnaposto: lo stato si aggiorna da solo via Realtime/polling. */}
      <div style={{ marginTop: 16 }}>
        <Button variant="ghost" disabled>
          Aggiorna stato
        </Button>
      </div>
    </Screen>
  );
}
