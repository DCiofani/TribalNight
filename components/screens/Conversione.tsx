// G9 — Conversione finale (LAST_CALL) + modale G9b. Porting FEDELE dal mockup Claude
// ("G9 Last Call" / "G9b Conferma").
//
// PRESENTAZIONALE: badge "LAST CALL" (Cinzel ambra, pulse), titolo, pannello riepilogo
// del credito RESIDUO (saldi Normali/Premium PASSATI come prop dal server via
// useGuestState) + anteprima "= +N ticket" SE il parent la fornisce (NON la calcoliamo
// qui). Body sull'irreversibilità. Primary "Converti tutto in ticket" → apre la modale
// G9b (bottom-sheet) con conferma esplicita "SEI SICURO? IRREVERSIBILE".
//
// Il front-end NON calcola MAI ticket/saldi: `saldoNormale`/`saldoPremium` e
// `anteprimaTicket` arrivano dal server; `onConferma` chiama convert_credit (parent).
// Post-conversione il parent smonta il componente (saldi→0 via useGuestState); qui
// esponiamo comunque il post-stato "Convertito ✓" via prop `done` per completezza.
'use client';

import React, { useEffect, useState } from 'react';
import Totem from '@/components/Totem';

type Props = {
  saldoNormale: number; // residuo NORMALI (dal server, mai calcolato qui)
  saldoPremium: number; // residuo PREMIUM (dal server, mai calcolato qui)
  anteprimaTicket?: number | null; // "= +N ticket" SE disponibile dal server; altrimenti nascosta
  busy: boolean; // conversione in corso (bottone/CTA in loading)
  error?: string | null; // messaggio d'errore dal parent (fase errata, permesso, ecc.)
  done?: boolean; // true dopo il successo: mostra "Convertito ✓"
  onConferma: () => void; // → convert_credit nel parent
  onAnnulla?: () => void; // link "Non ora" (opzionale; chiude/torna all'hub)
  seed?: number; // seed dell'ospite → totem coerente con l'hub
};

// Colori letterali del mockup G9/G9b.
const EMBER = '#EE6321';
const GOLD = '#F2B43C';
const TEXT2 = '#D8C3A6';
const TEXT3 = '#A58A66';
const SURFACE = '#2A1A11';
const BORDER = '#43291A';
const BORDER2 = '#4A2D1C';

// Pluralizzazione minima delle etichette residuo (solo presentazione).
function label(n: number, sing: string, plur: string): string {
  return `${n} ${n === 1 ? sing : plur}`;
}

export default function Conversione({
  saldoNormale,
  saldoPremium,
  anteprimaTicket,
  busy,
  error,
  done = false,
  onConferma,
  onAnnulla,
  seed = 5,
}: Props) {
  // Modale G9b (bottom-sheet) di conferma irreversibile.
  const [confirm, setConfirm] = useState(false);

  // rispetta prefers-reduced-motion: niente pulse del badge/totem.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  // A conversione riuscita chiudiamo la modale (il parent smonterà comunque).
  useEffect(() => {
    if (done) setConfirm(false);
  }, [done]);

  // Riepilogo residuo (es. "2 NORMALI · 1 PREMIUM"). Componiamo SOLO stringhe dai saldi
  // passati dal server: nessuna somma/derivazione di valori autoritativi.
  const residuo = `${label(saldoNormale, 'NORMALE', 'NORMALI')} · ${label(saldoPremium, 'PREMIUM', 'PREMIUM')}`;
  const hasAnteprima = anteprimaTicket != null;

  const keyframes = `
    @keyframes cv-blink { 0%,100%{ opacity:1 } 50%{ opacity:.4 } }
    @keyframes cv-pulse { 0%,100%{ opacity:.42 } 50%{ opacity:.62 } }
    @keyframes cv-sheet-in { from{ transform:translateY(100%) } to{ transform:translateY(0) } }
  `;

  // Post-stato "Convertito ✓" (schermata piena, calma).
  if (done) {
    return (
      <div
        style={{
          position: 'relative',
          minHeight: '100dvh',
          overflow: 'hidden',
          color: '#fff',
          fontFamily: 'var(--font-ui)',
          background:
            'radial-gradient(80% 50% at 50% 40%, rgba(242,180,60,.18) 0%, transparent 62%), #160C06',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '0 30px',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 64,
            color: GOLD,
            lineHeight: 0.9,
            textShadow: '0 0 40px rgba(242,180,60,.5)',
          }}
        >
          ✓
        </div>
        <div
          style={{
            fontFamily: 'var(--font-ritual)',
            letterSpacing: '.24em',
            fontSize: 15,
            color: '#fff',
            marginTop: 14,
          }}
        >
          CONVERTITO
        </div>
        <div style={{ color: TEXT2, fontSize: 14, marginTop: 14, lineHeight: 1.5 }}>
          Il tuo credito è ora in ticket. In bocca al lupo per l&apos;estrazione.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100dvh',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'var(--font-ui)',
        background:
          'radial-gradient(90% 60% at 50% 70%, rgba(242,180,60,.14) 0%, transparent 60%), #160C06',
      }}
    >
      <style>{keyframes}</style>

      {/* totem sullo sfondo che pulsa d'oro (attenuato) */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          top: 380,
          opacity: 0.5,
          pointerEvents: 'none',
          animation: reduceMotion ? 'none' : 'cv-pulse 3.2s ease-in-out infinite',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
        }}
      >
        <Totem level={6} seed={seed} size={220} />
      </div>

      {/* contenuto scrollabile (safe-area top) */}
      <div style={{ position: 'relative', padding: '62px 28px 0' }}>
        <div
          style={{
            display: 'inline-block',
            fontFamily: 'var(--font-ritual)',
            letterSpacing: '.26em',
            fontSize: 12,
            color: EMBER,
            border: `1px solid ${EMBER}`,
            borderRadius: 99,
            padding: '6px 14px',
            animation: reduceMotion ? 'none' : 'cv-blink 1.4s ease-in-out infinite',
          }}
        >
          LAST CALL
        </div>

        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 38,
            lineHeight: 0.98,
            marginTop: 18,
          }}
        >
          TRASFORMA IL
          <br />
          CREDITO IN TICKET
        </div>

        {/* pannello riepilogo residuo + anteprima ticket (se fornita dal server) */}
        <div
          style={{
            marginTop: 22,
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: 16,
            padding: 18,
          }}
        >
          <div style={{ color: TEXT2, fontSize: 14 }}>Hai ancora</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, marginTop: 4 }}>
            {residuo}
          </div>
          {hasAnteprima && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 14,
                paddingTop: 14,
                borderTop: `1px solid ${BORDER}`,
              }}
            >
              <span style={{ color: TEXT3, fontSize: 22 }}>→</span>
              <span
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 30,
                  color: GOLD,
                }}
              >
                +{anteprimaTicket} ticket
              </span>
            </div>
          )}
        </div>

        <div style={{ color: TEXT2, fontSize: 13, marginTop: 14, lineHeight: 1.5 }}>
          Le consumazioni non si rimborsano: convertile e gioca l&apos;estrazione.
        </div>

        {error && (
          <div
            style={{
              marginTop: 14,
              background: 'rgba(238,99,33,.1)',
              border: '1px solid rgba(238,99,33,.4)',
              borderRadius: 12,
              padding: '12px 14px',
              color: '#F3B08A',
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* CTA primaria full-width: apre la modale di conferma G9b */}
      <div
        style={{
          position: 'absolute',
          left: 28,
          right: 28,
          bottom: 'max(96px, calc(env(safe-area-inset-bottom) + 72px))',
        }}
      >
        <button
          onClick={() => setConfirm(true)}
          disabled={busy}
          className="btn"
          style={{
            width: '100%',
            height: 58,
            borderRadius: 14,
            background: `linear-gradient(90deg,${EMBER},${GOLD})`,
            color: '#1A0F08',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: 16,
            fontFamily: 'var(--font-ui)',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.7 : 1,
            boxShadow: '0 0 28px rgba(242,180,60,.45)',
          }}
        >
          {busy ? 'Conversione…' : 'Converti tutto in ticket'}
        </button>
      </div>

      {/* link secondario tenue "Non ora" */}
      {onAnnulla && (
        <button
          onClick={onAnnulla}
          disabled={busy}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 'max(56px, calc(env(safe-area-inset-bottom) + 32px))',
            textAlign: 'center',
            color: TEXT3,
            fontSize: 13,
            background: 'none',
            border: 'none',
            cursor: busy ? 'default' : 'pointer',
            fontFamily: 'var(--font-ui)',
          }}
        >
          Non ora
        </button>
      )}

      {/* ── Modale G9b: conferma IRREVERSIBILE (bottom-sheet) ──────────────── */}
      {confirm && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: 'absolute', inset: 0, zIndex: 20 }}
        >
          {/* scrim scuro: tap fuori = annulla (se non busy) */}
          <div
            onClick={() => !busy && setConfirm(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(14,8,4,.82)' }}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              background: SURFACE,
              borderTop: `1px solid ${BORDER2}`,
              borderRadius: '24px 24px 0 0',
              padding: '28px 26px max(40px, calc(env(safe-area-inset-bottom) + 24px))',
              animation: reduceMotion ? 'none' : 'cv-sheet-in .28s ease-out',
            }}
          >
            <div
              style={{
                width: 42,
                height: 4,
                borderRadius: 99,
                background: '#5A3826',
                margin: '0 auto 22px',
              }}
            />
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 30 }}>SEI SICURO?</div>
            <div
              style={{
                color: TEXT2,
                fontSize: 14.5,
                marginTop: 12,
                lineHeight: 1.55,
              }}
            >
              La conversione è <b style={{ color: EMBER }}>IRREVERSIBILE</b>. Le consumazioni
              convertite non potranno essere riaccreditate né rimborsate.
            </div>

            {hasAnteprima && (
              <div
                style={{
                  marginTop: 18,
                  background: 'rgba(242,180,60,.08)',
                  border: '1px solid rgba(242,180,60,.3)',
                  borderRadius: 12,
                  padding: 14,
                  fontFamily: 'var(--font-display)',
                  fontSize: 20,
                  color: GOLD,
                }}
              >
                {residuo.replace(/·/g, '+')} → +{anteprimaTicket} ticket
              </div>
            )}

            {error && (
              <div
                style={{
                  marginTop: 16,
                  color: '#F3B08A',
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
              >
                {error}
              </div>
            )}

            <button
              onClick={onConferma}
              disabled={busy}
              className="btn"
              style={{
                marginTop: 22,
                width: '100%',
                height: 56,
                borderRadius: 14,
                background: `linear-gradient(90deg,${EMBER},${GOLD})`,
                color: '#1A0F08',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 16,
                fontFamily: 'var(--font-ui)',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.7 : 1,
              }}
            >
              {busy ? 'Conversione…' : 'Sì, converti'}
            </button>
            <button
              onClick={() => setConfirm(false)}
              disabled={busy}
              style={{
                marginTop: 12,
                width: '100%',
                height: 54,
                borderRadius: 14,
                border: `1px solid ${BORDER2}`,
                background: 'transparent',
                color: TEXT2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 600,
                fontSize: 15,
                fontFamily: 'var(--font-ui)',
                cursor: busy ? 'default' : 'pointer',
              }}
            >
              Annulla
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
