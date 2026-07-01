// G10 — Estrazione: attesa → reveal. Porting FEDELE dai mockup Claude
// ("G10a Attesa" / "G10b Win" / "G10c Lose").
//
// PRESENTAZIONALE, tri-stato:
//   'attesa' (G10a): totem che pulsa lento d'oro, anello tratteggiato in rotazione,
//                    "ESTRAZIONE IN CORSO" + "i tuoi N ticket sono in gioco".
//   'win'    (G10b): esplosione di scintille oro dal totem a livello 6, "HAI VINTO!",
//                    etichetta premio, "come ritirare".
//   'lose'   (G10c): totem che torna a glow viola calmo, "NIENTE PREMIO STAVOLTA",
//                    "N ticket giocati".
//
// L'ESITO NON è calcolato qui: `stato` (attesa/win/lose) e `premio` arrivano dal server
// (my_draw_result) via il parent; `ticket` è il conteggio LIVE da useGuestState. Rispetta
// prefers-reduced-motion (niente rotazione/pioggia/pulse quando richiesto).
'use client';

import React, { useEffect, useState } from 'react';
import Totem from '@/components/Totem';

type Props = {
  stato: 'attesa' | 'win' | 'lose';
  ticket: number; // "ticket in gioco" / "ticket giocati" — dal server, mai calcolato qui
  premio?: string | null; // etichetta premio se vinto (es. "1° posto"); altrimenti null
  onComeRitirare?: () => void; // CTA "Come ritirare" (win); opzionale
  seed?: number; // seed dell'ospite → totem coerente con l'hub
};

// Colori letterali dei mockup G10.
const GOLD = '#F2B43C';
const TEXT2 = '#D8C3A6';

// pioggia di scintille d'oro (deterministica) — puramente estetica (win).
const GOLD_RAIN = Array.from({ length: 12 }, (_, i) => ({
  left: (i * 8.3 + 3) % 100,
  dur: 2.4 + (i % 4) * 0.5,
  delay: (i % 6) * 0.4,
}));

export default function Reveal({ stato, ticket, premio, onComeRitirare, seed = 5 }: Props) {
  // rispetta prefers-reduced-motion: niente spin/pioggia/pulse.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  const keyframes = `
    @keyframes rv-spin { to { transform:translate(-50%,-50%) rotate(360deg); } }
    @keyframes rv-rain { 0%{ transform:translateY(0); opacity:0 } 12%{ opacity:.9 } 100%{ transform:translateY(120vh); opacity:0 } }
    @keyframes rv-pulse { 0%,100%{ opacity:.7 } 50%{ opacity:1 } }
  `;

  // ── WIN (G10b) ─────────────────────────────────────────────────────────────
  if (stato === 'win') {
    return (
      <div
        style={{
          position: 'relative',
          minHeight: '100dvh',
          overflow: 'hidden',
          color: '#fff',
          fontFamily: 'var(--font-ui)',
          background:
            'radial-gradient(70% 45% at 50% 36%, rgba(242,180,60,.32) 0%, transparent 60%), #160C06',
        }}
      >
        <style>{keyframes}</style>

        {/* pioggia di scintille d'oro */}
        {!reduceMotion && (
          <div
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
          >
            {GOLD_RAIN.map((g, i) => (
              <span
                key={i}
                style={{
                  position: 'absolute',
                  top: -20,
                  left: `${g.left}%`,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: GOLD,
                  opacity: 0,
                  boxShadow: `0 0 8px ${GOLD}`,
                  animation: `rv-rain ${g.dur}s linear ${g.delay}s infinite`,
                }}
              />
            ))}
          </div>
        )}

        {/* totem a livello 6 "in fiamme" */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 80,
            bottom: 360,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Totem level={6} seed={seed} size={240} />
        </div>

        <div style={{ position: 'absolute', left: 0, right: 0, top: 500, textAlign: 'center', padding: '0 24px' }}>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 72,
              color: GOLD,
              lineHeight: 0.9,
              textShadow: '0 0 50px rgba(242,180,60,.6)',
            }}
          >
            HAI VINTO!
          </div>
          {premio && (
            <div
              style={{
                fontFamily: 'var(--font-ritual)',
                fontWeight: 700,
                letterSpacing: '.26em',
                fontSize: 18,
                marginTop: 14,
                textTransform: 'uppercase',
              }}
            >
              — {premio} —
            </div>
          )}
          <div style={{ color: TEXT2, fontSize: 14, marginTop: 12 }}>
            Mostra questo schermo allo staff per ritirare.
          </div>
        </div>

        {onComeRitirare && (
          <div style={{ position: 'absolute', left: 30, right: 30, bottom: 'max(54px, calc(env(safe-area-inset-bottom) + 30px))' }}>
            <button
              onClick={onComeRitirare}
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
              Come ritirare
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── LOSE (G10c) ────────────────────────────────────────────────────────────
  if (stato === 'lose') {
    return (
      <div
        style={{
          position: 'relative',
          minHeight: '100dvh',
          overflow: 'hidden',
          color: '#fff',
          fontFamily: 'var(--font-ui)',
          background:
            'radial-gradient(80% 55% at 50% 40%, rgba(58,91,190,.18) 0%, transparent 62%), #160C06',
        }}
      >
        {/* totem calmo (glow viola dello sfondo) */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 120,
            bottom: 320,
            opacity: 0.85,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Totem level={3} seed={seed} size={220} />
        </div>

        <div style={{ position: 'absolute', left: 0, right: 0, top: 540, textAlign: 'center', padding: '0 30px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, lineHeight: 1 }}>
            NIENTE PREMIO
            <br />
            STAVOLTA
          </div>
          <div style={{ color: TEXT2, fontSize: 15, marginTop: 16, lineHeight: 1.5 }}>
            Grazie per aver acceso il tuo totem. È stata una bella serata.
          </div>
          <div
            style={{
              fontFamily: 'var(--font-ritual)',
              letterSpacing: '.22em',
              fontSize: 13,
              color: GOLD,
              marginTop: 20,
            }}
          >
            {ticket} TICKET GIOCATI
          </div>
        </div>
      </div>
    );
  }

  // ── ATTESA (G10a) ──────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100dvh',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'var(--font-ui)',
        background:
          'radial-gradient(80% 55% at 50% 44%, rgba(242,180,60,.16) 0%, transparent 62%), #160C06',
      }}
    >
      <style>{keyframes}</style>

      {/* anello tratteggiato che ruota lento (biglietti in gioco) */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '50%',
          top: 300,
          transform: 'translate(-50%,-50%)',
          width: 340,
          height: 340,
          borderRadius: '50%',
          border: '1px dashed rgba(242,180,60,.25)',
          animation: reduceMotion ? 'none' : 'rv-spin 18s linear infinite',
        }}
      />

      {/* totem che pulsa lento d'oro */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 120,
          bottom: 330,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          animation: reduceMotion ? 'none' : 'rv-pulse 2.6s ease-in-out infinite',
        }}
      >
        <Totem level={6} seed={seed} size={220} />
      </div>

      <div style={{ position: 'absolute', left: 0, right: 0, top: 540, textAlign: 'center', padding: '0 30px' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 36, lineHeight: 1 }}>
          ESTRAZIONE
          <br />
          IN CORSO
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: GOLD, marginTop: 18 }}>
          I tuoi {ticket} ticket sono in gioco
        </div>
        <div
          style={{
            fontFamily: 'var(--font-ritual)',
            letterSpacing: '.24em',
            fontSize: 12,
            color: TEXT2,
            marginTop: 14,
          }}
        >
          TIENI D&apos;OCCHIO IL TOTEM…
        </div>
      </div>
    </div>
  );
}
