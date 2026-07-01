// G8 — Esito tap. Porting FEDELE dal mockup Claude ("G8 Esito").
// PRESENTAZIONALE: grande numero ticket guadagnati (oro, count-up) + tap totali + CTA
// "Torna al totem". I ticket NON sono calcolati qui: `ticketGuadagnati` è il DELTA letto
// da useGuestState (PRIMA/DOPO close_session) e passato dal parent. Se il regista non ha
// ancora chiuso la sessione, il parent può passare uno stato "in arrivo" via `pending`.
'use client';

import React, { useEffect, useRef, useState } from 'react';
import Totem from '@/components/Totem';

type Props = {
  ticketGuadagnati: number; // DELTA autoritativo (dopo - prima) — 0 = nessun ticket
  tapTotali: number; // conteggio tap locale della sessione (UX)
  onDone: () => void; // torna a hub 'totem'
  pending?: boolean; // true finché close_session non ha assegnato i ticket ("in arrivo")
  seed?: number; // seed dell'ospite → totem coerente con l'hub
};

// Colori letterali del mockup G8.
const GOLD = '#F5C451';
const GOLD_SOFT = '#F2B43C';

// count-up animato (rispetta prefers-reduced-motion: salta direttamente al valore).
function useCountUp(target: number, active: boolean, durationMs = 900): number {
  const [val, setVal] = useState(active ? 0 : target);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setVal(target);
      return;
    }
    // reduced-motion → nessuna animazione, valore finale subito.
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || target <= 0) {
      setVal(target);
      return;
    }

    startRef.current = null;
    const step = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const t = Math.min(1, (ts - startRef.current) / durationMs);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(target * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, active, durationMs]);

  return val;
}

// pioggia leggera di scintille d'ambra (deterministica) — puramente estetica.
const RAIN = Array.from({ length: 10 }, (_, i) => ({
  left: (i * 9.7 + 4) % 100,
  dur: 2.2 + (i % 4) * 0.6,
  delay: (i % 5) * 0.5,
}));

export default function EsitoTap({ ticketGuadagnati, tapTotali, onDone, pending = false, seed = 5 }: Props) {
  const showCount = !pending; // durante l'attesa non animiamo il numero
  const count = useCountUp(ticketGuadagnati, showCount);

  // 0 ticket = messaggio dedicato (edge del design). Livello alto per il totem "che assorbe".
  const zero = !pending && ticketGuadagnati <= 0;

  const keyframes = `
    @keyframes et-rain {
      0% { transform: translateY(0); opacity: 0; }
      12% { opacity: .8; }
      100% { transform: translateY(120vh); opacity: 0; }
    }
    @keyframes et-fade { 0%,100%{ opacity:.5 } 50%{ opacity:1 } }
  `;

  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100dvh',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'var(--font-ui)',
        background:
          'radial-gradient(80% 50% at 50% 38%, rgba(242,180,60,.16) 0%, transparent 60%), #160C06',
      }}
    >
      <style>{keyframes}</style>

      {/* pioggia di scintille d'ambra che si spegne */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        {RAIN.map((g, i) => (
          <span
            key={i}
            style={{
              position: 'absolute',
              top: -20,
              left: `${g.left}%`,
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: GOLD_SOFT,
              opacity: 0,
              animation: `et-rain ${g.dur}s linear ${g.delay}s infinite`,
            }}
          />
        ))}
      </div>

      {/* totem che "assorbe" le scintille */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 120,
          bottom: 300,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <Totem level={5} seed={seed} size={220} />
      </div>

      {/* blocco reward */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 470, textAlign: 'center', padding: '0 24px' }}>
        {pending ? (
          <>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 56,
                color: GOLD,
                lineHeight: 0.9,
                textShadow: '0 0 40px rgba(242,180,60,.5)',
                animation: 'et-fade 1.2s ease-in-out infinite',
              }}
            >
              …
            </div>
            <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.3em', fontSize: 15, color: '#fff', marginTop: 4 }}>
              TICKET IN ARRIVO
            </div>
            <div style={{ color: '#D8C3A6', fontSize: 14, marginTop: 14 }}>
              La regia sta chiudendo la sessione…
            </div>
          </>
        ) : zero ? (
          <>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 56,
                color: '#D8C3A6',
                lineHeight: 0.9,
              }}
            >
              +0
            </div>
            <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.3em', fontSize: 15, color: '#fff', marginTop: 4 }}>
              NESSUN TICKET STAVOLTA
            </div>
            <div style={{ color: '#D8C3A6', fontSize: 14, marginTop: 14 }}>
              Riprova alla prossima sessione
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 88,
                color: GOLD,
                lineHeight: 0.9,
                textShadow: '0 0 40px rgba(242,180,60,.5)',
              }}
            >
              +{count}
            </div>
            <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.3em', fontSize: 15, color: '#fff', marginTop: 4 }}>
              TICKET GUADAGNATI
            </div>
            <div style={{ color: '#D8C3A6', fontSize: 14, marginTop: 14 }}>
              {tapTotali} tap in questa sessione
            </div>
          </>
        )}
      </div>

      {/* CTA: torna al totem */}
      <div style={{ position: 'absolute', left: 30, right: 30, bottom: 'max(54px, calc(env(safe-area-inset-bottom) + 30px))' }}>
        <button
          onClick={onDone}
          className="btn"
          style={{
            width: '100%',
            height: 56,
            borderRadius: 14,
            background: '#3A5BBE',
            color: '#fff',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontSize: 16,
            fontFamily: 'var(--font-ui)',
            cursor: 'pointer',
            boxShadow: '0 0 24px rgba(58,91,190,.4)',
          }}
        >
          Torna al totem
        </button>
      </div>
    </div>
  );
}
