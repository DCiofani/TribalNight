// G7 — Arena tap (sessione attiva). Porting FEDELE dal mockup Claude ("G7 Tap Arena").
// PRESENTAZIONALE + INPUT: riceve i dati come prop, emette solo onTap. NON calcola nulla
// di autoritativo — `tapLocali` è un contatore locale OTTIMISTICO (UX); i ticket veri
// arrivano dal DB dopo close_session (vedi EsitoTap + page). Full-screen immersivo:
// nessuna navigazione. Il TOTEM (livello alto 5–6) è la SUPERFICIE TAP (onPointerDown),
// con burst d'ambra ad ogni tap. Countdown grande (Anton) + anello che si svuota (ambra).
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Totem from '@/components/Totem';
import TotemMaskField from '@/components/TotemMaskField';

type Props = {
  secondiRimasti: number; // finestra UX ricalcolata dalla scadenza server (non un timer cieco)
  tapLocali: number; // contatore locale ottimistico (NON autoritativo)
  onTap: () => void; // notifica un tap al parent (che aggiorna tapLocali + batch registerTaps)
  level: number; // livello totem alto (5–6) per l'arena
  seed: number; // seed deterministico dell'ospite → totem stabile
};

// Colori letterali del mockup G7 (palette calda africana; ok usare i letterali del reso).
const EMBER = '#EE6321'; // ambra dell'anello/burst
const GOLD = '#F2B43C'; // oro del burst/ticket stimati
const TRACK = '#3A2414'; // traccia spenta dell'anello

// Anello countdown: r=44 → circonferenza ≈ 276 (come nel mockup). Durata di riferimento
// per lo "svuotamento" visivo: prendiamo il massimo osservato di secondiRimasti (tipico 30s).
const RING_R = 44;
const RING_CIRC = 2 * Math.PI * RING_R; // ≈ 276.46

// mm:ss? No: il mockup mostra i soli secondi ("21"). Manteniamo i secondi grandi.
function fmtSecondi(s: number): string {
  const v = Math.max(0, Math.floor(s));
  return String(v);
}

// Burst effimero d'ambra al tap: posizioni radiali deterministiche per id.
type Burst = { id: number; bx: number; by: number; size: number };

export default function TapArena({ secondiRimasti, tapLocali, onTap, level, seed }: Props) {
  // Livello alto per l'arena (5–6), comunque clampato.
  const lvl = Math.max(5, Math.min(6, Math.round(level || 6)));

  // Durata di riferimento dell'anello: la fissiamo al PRIMO valore utile di
  // secondiRimasti visto (tipicamente la durata piena della sessione). Così l'anello si
  // svuota da "pieno" a "vuoto" in modo coerente anche se non conosciamo la durata a priori.
  const totRef = useRef<number>(0);
  if (secondiRimasti > totRef.current) totRef.current = secondiRimasti;
  const tot = Math.max(1, totRef.current);
  const frac = Math.max(0, Math.min(1, secondiRimasti / tot)); // 1=pieno, 0=vuoto
  // Anello "che si svuota": offset cresce mentre il tempo scende.
  const dashOffset = RING_CIRC * (1 - frac);

  const last5 = secondiRimasti <= 5 && secondiRimasti > 0;

  // rispetta prefers-reduced-motion: niente burst/pulse se l'utente lo chiede.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  // Coda di burst effimeri: ogni tap ne aggiunge uno, che si auto-rimuove a fine anim.
  const [bursts, setBursts] = useState<Burst[]>([]);
  const burstSeq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [];
    };
  }, []);

  const spawnBurst = useCallback(() => {
    if (reduceMotion) return;
    const id = ++burstSeq.current;
    // direzione radiale pseudo-casuale (deterministica sull'id) verso l'esterno.
    const ang = (id * 137.508 * Math.PI) / 180; // angolo aureo → distribuzione uniforme
    const dist = 70 + (id % 5) * 14;
    const bx = Math.cos(ang) * dist;
    const by = Math.sin(ang) * dist;
    const size = 10 + (id % 4) * 3;
    setBursts((prev) => [...prev, { id, bx, by, size }]);
    const t = setTimeout(() => {
      setBursts((prev) => prev.filter((b) => b.id !== id));
    }, 620);
    timers.current.push(t);
  }, [reduceMotion]);

  // punch di scala del totem al tap (breve). Solo se motion consentito.
  const [punch, setPunch] = useState(false);
  const punchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTap = useCallback(
    (e: React.PointerEvent) => {
      // evita menu/selezione/zoom su mobile durante il tapping frenetico.
      e.preventDefault();
      onTap();
      spawnBurst();
      if (!reduceMotion) {
        setPunch(true);
        if (punchTimer.current) clearTimeout(punchTimer.current);
        punchTimer.current = setTimeout(() => setPunch(false), 120);
      }
    },
    [onTap, spawnBurst, reduceMotion],
  );

  useEffect(() => {
    return () => {
      if (punchTimer.current) clearTimeout(punchTimer.current);
    };
  }, []);

  const keyframes = `
    @keyframes ta-burst {
      0% { transform: translate(-50%,-50%) scale(.4); opacity: 1; }
      100% { transform: translate(calc(-50% + var(--bx)), calc(-50% + var(--by))) scale(1.15); opacity: 0; }
    }
    @keyframes ta-pulse { 0%,100%{ opacity:.5 } 50%{ opacity:1 } }
    @keyframes ta-ringblink { 0%,100%{ opacity:1 } 50%{ opacity:.35 } }
  `;

  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100dvh',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'var(--font-ui)',
        // sfondo saturo di glow viola/ambra come da mockup G7
        background:
          'radial-gradient(80% 55% at 50% 48%, rgba(58,91,190,.3) 0%, transparent 65%), #160C06',
        touchAction: 'none', // niente scroll/zoom durante l'arena
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <style>{keyframes}</style>

      {/* anelli tribali che pulsano (pattern del mockup) */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'repeating-radial-gradient(circle at 50% 48%, rgba(238,99,33,.05) 0 1px, transparent 1px 40px)',
          animation: reduceMotion ? 'none' : 'ta-pulse 1.6s ease-in-out infinite',
        }}
      />

      {/* campo maschere di sfondo, livello alto */}
      <TotemMaskField level={lvl} />

      {/* header: micro-istruzione + countdown ring */}
      <div style={{ position: 'relative', paddingTop: 'max(62px, calc(env(safe-area-inset-top) + 24px))', textAlign: 'center' }}>
        <div
          style={{
            fontFamily: 'var(--font-ritual)',
            letterSpacing: '.3em',
            fontSize: 12,
            color: EMBER,
            animation: reduceMotion ? 'none' : 'ta-pulse 1s ease-in-out infinite',
          }}
        >
          TOCCA IL TOTEM!
        </div>
        <div style={{ position: 'relative', width: 96, height: 96, margin: '14px auto 0' }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
            <circle cx="50" cy="50" r={RING_R} fill="none" stroke={TRACK} strokeWidth="7" />
            <circle
              cx="50"
              cy="50"
              r={RING_R}
              fill="none"
              stroke={EMBER}
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={RING_CIRC}
              strokeDashoffset={dashOffset}
              style={{
                filter: `drop-shadow(0 0 6px ${EMBER})`,
                transition: 'stroke-dashoffset 1s linear',
                animation: last5 && !reduceMotion ? 'ta-ringblink .5s ease-in-out infinite' : 'none',
              }}
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
              fontSize: 30,
              color: last5 ? EMBER : '#fff',
            }}
          >
            {fmtSecondi(secondiRimasti)}
          </div>
        </div>
      </div>

      {/* SUPERFICIE TAP = il totem (onPointerDown). Occupa la banda centrale. */}
      <div
        onPointerDown={handleTap}
        role="button"
        aria-label="Tocca il totem"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onTap();
            spawnBurst();
          }
        }}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 230,
          bottom: 170,
          cursor: 'pointer',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          touchAction: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none', // i tap li prende il contenitore, non il Totem interno
            transform: punch ? 'scale(1.06)' : 'scale(1)',
            transition: reduceMotion ? 'none' : 'transform .12s ease-out',
          }}
        >
          <Totem level={lvl} seed={seed} size={260} />
        </div>

        {/* burst d'ambra effimeri, centrati sul totem */}
        {bursts.map((b) => (
          <span
            key={b.id}
            aria-hidden="true"
            style={
              {
                position: 'absolute',
                left: '50%',
                top: '46%',
                width: b.size,
                height: b.size,
                borderRadius: '50%',
                background: GOLD,
                boxShadow: `0 0 10px ${EMBER}`,
                pointerEvents: 'none',
                ['--bx' as string]: `${b.bx}px`,
                ['--by' as string]: `${b.by}px`,
                animation: 'ta-burst .6s ease-out forwards',
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {/* contatore tap enorme + "ticket in arrivo" (solo UX ottimistica, non autoritativo) */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 'max(72px, calc(env(safe-area-inset-bottom) + 40px))', textAlign: 'center', pointerEvents: 'none' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 64, lineHeight: 0.9 }}>
          {tapLocali}
          <span style={{ fontSize: 22, color: '#D8C3A6', letterSpacing: '.1em' }}> TAP</span>
        </div>
        <div
          style={{
            fontFamily: 'var(--font-ritual)',
            letterSpacing: '.2em',
            fontSize: 14,
            color: GOLD,
            marginTop: 6,
          }}
        >
          I TICKET ARRIVANO A FINE SESSIONE
        </div>
      </div>
    </div>
  );
}
