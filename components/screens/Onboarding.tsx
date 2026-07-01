// G1 — Onboarding nome (+ consenso T&C). Porting fedele dal mockup Claude.
// Presentazionale: form state e submit arrivano come prop (logica nella page).
'use client';

import React from 'react';
import Totem from '@/components/Totem';

// Fase della coreografia rituale (specchio del type in app/onboarding/page.tsx).
type IgnitePhase = 'idle' | 'ignite' | 'peak' | 'decolor' | 'reveal' | 'handoff';

type Props = {
  nome: string;
  onNome: (v: string) => void;
  accettato: boolean;
  onAccettato: (v: boolean) => void;
  submitting: boolean;
  errore: string | null;
  canSubmit: boolean;
  onSubmit: (e: React.FormEvent) => void;
  // Fase d'accensione rituale (dopo la registrazione, prima di /guest). Presentazionale:
  // il livello che sale e la fase arrivano dalla page, qui li mostriamo soltanto.
  igniting?: boolean;
  igniteLevel?: number;
  ignitePhase?: IgnitePhase;
  // In reduced-motion l'overlay renderizza gli elementi allo stato finale, senza keyframe.
  reducedMotion?: boolean;
};

// Ease "expo-out": scatto deciso poi rallentamento — feel "scena di gioco che si assembla".
const EASE_GAME = 'cubic-bezier(.16,1,.3,1)';

// Keyframe locali per l'overlay rituale (il Totem porta i propri).
const IGNITE_KEYFRAMES = `
@keyframes tmx-ignite-veil { from { opacity: 0 } to { opacity: 1 } }
@keyframes tmx-ignite-rise { 0% { opacity: 0; transform: translateY(10px) } 100% { opacity: 1; transform: translateY(0) } }
@keyframes tmx-peak-breathe { 0%,100% { opacity: .92 } 50% { opacity: 1 } }
@keyframes tmx-ring-expand { 0% { transform: translate(-50%,-50%) scale(.2); opacity: 0 } 55% { opacity: .9 } 100% { transform: translate(-50%,-50%) scale(1); opacity: .5 } }
@keyframes tmx-rain { 0% { transform: translateY(-24px) scale(.4); opacity: 0 } 30% { opacity: 1 } 100% { transform: translateY(40px) scale(1); opacity: 0 } }
@keyframes tmx-glyph-pop { 0% { transform: scale(.4) rotate(-8deg); opacity: 0 } 70% { transform: scale(1.12) rotate(2deg); opacity: 1 } 100% { transform: scale(1) rotate(0); opacity: .9 } }
@keyframes tmx-final-copy { 0% { opacity: 0; transform: translateY(14px) } 100% { opacity: 1; transform: translateY(0) } }
@keyframes tmx-handoff-out { from { opacity: 1 } to { opacity: 0 } }
`;

// 3 anelli tribali concentrici che si espandono dal centro-totem (stesso #F2B43C del ringSvg
// interno del Totem → sembrano "emanati" dal totem). In reduced: statici, opacità di arrivo.
const RING_SIZES = [340, 250, 168];
function RevealRings({ animate }: { animate: boolean }) {
  return (
    <>
      {RING_SIZES.map((d, i) => (
        <div
          key={`ring${i}`}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: d,
            height: d,
            marginLeft: 0,
            marginTop: 0,
            borderRadius: '50%',
            border: '1.5px solid #F2B43C',
            transform: 'translate(-50%,-50%)',
            opacity: 0.5,
            pointerEvents: 'none',
            animation: animate ? `tmx-ring-expand 700ms ${EASE_GAME} ${i * 120}ms both` : 'none',
          }}
        />
      ))}
    </>
  );
}

// Pioggia di scintille ambra/oro attorno al totem (stagger 200 + i*70ms).
const RAIN_XS = [12, 26, 40, 52, 63, 74, 84, 20, 33, 68, 88, 47];
function RevealRain({ animate }: { animate: boolean }) {
  return (
    <>
      {RAIN_XS.map((x, i) => {
        const gold = i % 2 === 0;
        return (
          <span
            key={`rain${i}`}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: `${18 + (i % 4) * 9}%`,
              width: 4 + (i % 3),
              height: 4 + (i % 3),
              borderRadius: '50%',
              background: gold ? '#F5C24A' : '#EE8A2C',
              boxShadow: `0 0 8px ${gold ? 'rgba(245,194,74,.9)' : 'rgba(238,138,44,.85)'}`,
              opacity: animate ? 0 : 0.85,
              pointerEvents: 'none',
              animation: animate ? `tmx-rain 900ms ${EASE_GAME} ${200 + i * 70}ms both` : 'none',
            }}
          />
        );
      })}
    </>
  );
}

// Glifi/rune di scena ai lati con overshoot (stagger 420 + i*110ms).
const GLYPHS = [
  { ch: '◈', left: '10%', top: '26%' },
  { ch: '⟡', left: '88%', top: '34%' },
  { ch: '❖', left: '14%', top: '70%' },
  { ch: '✧', left: '84%', top: '72%' },
];
function RevealGlyphs({ animate }: { animate: boolean }) {
  return (
    <>
      {GLYPHS.map((g, i) => (
        <span
          key={`gly${i}`}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: g.left,
            top: g.top,
            transform: animate ? undefined : 'scale(1)',
            fontSize: 22,
            color: '#F2B43C',
            textShadow: '0 0 14px rgba(242,180,60,.7)',
            opacity: animate ? 0 : 0.9,
            pointerEvents: 'none',
            animation: animate ? `tmx-glyph-pop 520ms ${EASE_GAME} ${420 + i * 110}ms both` : 'none',
          }}
        >
          {g.ch}
        </span>
      ))}
    </>
  );
}

function IgniteOverlay({
  level,
  phase,
  reduced,
}: {
  level: number;
  phase: IgnitePhase;
  reduced: boolean;
}) {
  // Il crossfade del copy: testo di fase-1 (ignite/peak) → testo rituale finale (decolor→).
  const showFinalCopy = phase === 'decolor' || phase === 'reveal' || phase === 'handoff';
  // Elementi di scena: montati e animati dalla fase reveal in poi; in reduced sono statici.
  const revealMounted = reduced || phase === 'reveal' || phase === 'handoff';
  const revealAnimate = revealMounted && !reduced;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        padding: '40px 30px',
        background: 'radial-gradient(120% 80% at 50% 42%, rgba(44,27,18,.92) 0%, rgba(11,6,3,.97) 70%)',
        backdropFilter: 'blur(2px)',
        // FASE 5 — HANDOFF: l'INTERO overlay svanisce (niente taglio secco verso /guest).
        opacity: phase === 'handoff' ? 0 : 1,
        transition: 'opacity .52s ease-in-out',
        animation: reduced ? 'none' : 'tmx-ignite-veil .35s ease-out both',
      }}
    >
      <style>{IGNITE_KEYFRAMES}</style>

      {/* Blocco Totem + elementi di scena. Gli anelli/pioggia/glifi si espandono dal suo centro. */}
      <div style={{ position: 'relative', width: 210, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {revealMounted && <RevealRings animate={revealAnimate} />}
        {/* Il Totem prende vita: level sale 0→6, glow progressivo + tmx-awake sulle maschere. */}
        <div style={{ position: 'relative', zIndex: 1 }}>
          <Totem level={level} size={210} />
        </div>
        {revealMounted && <RevealRain animate={revealAnimate} />}
        {revealMounted && <RevealGlyphs animate={revealAnimate} />}
      </div>

      {/* Copy con crossfade: due blocchi sovrapposti, opacità pilotata dalla fase. */}
      <div
        style={{
          position: 'relative',
          textAlign: 'center',
          animation: reduced ? 'none' : 'tmx-ignite-rise .5s ease-out both',
          minHeight: 92,
          width: '100%',
        }}
      >
        {/* Copy fase-1: "IL TUO TOTEM PRENDE VITA" */}
        <div
          style={{
            position: showFinalCopy ? 'absolute' : 'relative',
            inset: showFinalCopy ? 0 : undefined,
            opacity: showFinalCopy ? 0 : 1,
            transition: 'opacity .5s ease-in-out',
          }}
        >
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 30,
              lineHeight: 1.0,
              letterSpacing: '.04em',
              margin: 0,
              textTransform: 'uppercase',
              color: '#fff',
              textShadow: '0 0 22px rgba(255,168,72,.55)',
              animation: reduced || phase !== 'peak' ? 'none' : 'tmx-peak-breathe 1.6s ease-in-out infinite',
            }}
          >
            IL TUO TOTEM<br />PRENDE VITA
          </h2>
          <div style={{ marginTop: 12, color: '#D89A3E', fontSize: 13, letterSpacing: '.2em', textTransform: 'uppercase' }}>
            La serata è tua
          </div>
        </div>

        {/* Copy rituale finale: "LA TUA SERATA COMINCIA" (crossfade da fase decolor). */}
        <div
          style={{
            position: showFinalCopy ? 'relative' : 'absolute',
            inset: showFinalCopy ? undefined : 0,
            opacity: showFinalCopy ? 1 : 0,
            transition: 'opacity .5s ease-in-out',
          }}
        >
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 30,
              lineHeight: 1.0,
              letterSpacing: '.04em',
              margin: 0,
              textTransform: 'uppercase',
              color: '#fff',
              textShadow: '0 0 22px rgba(255,168,72,.55)',
              animation: reduced || phase !== 'reveal' ? 'none' : `tmx-final-copy 560ms ${EASE_GAME} 640ms both`,
            }}
          >
            LA TUA SERATA<br />COMINCIA
          </h2>
          <div style={{ marginTop: 12, color: '#D89A3E', fontSize: 13, letterSpacing: '.2em', textTransform: 'uppercase' }}>
            La serata è tua
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Onboarding({ nome, onNome, accettato, onAccettato, submitting, errore, canSubmit, onSubmit, igniting = false, igniteLevel = 0, ignitePhase = 'idle', reducedMotion = false }: Props) {
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      style={{
        position: 'relative',
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'var(--font-ui)',
        background: 'radial-gradient(120% 80% at 50% 18%, #2C1B12 0%, #160C06 62%)',
      }}
    >
      <div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'repeating-radial-gradient(circle at 50% 16%, rgba(212,150,70,.04) 0 1px, transparent 1px 48px)' }}
      />

      {/* G1 normale: Totem spento (level 0). L'accensione è gestita dall'overlay sotto. */}
      <div style={{ position: 'relative', height: 280, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingTop: 'max(30px, env(safe-area-inset-top))' }}>
        <Totem level={0} size={170} />
      </div>

      <div style={{ position: 'relative', padding: '8px 30px 0' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 38, lineHeight: 0.96, letterSpacing: '.02em', margin: 0, textTransform: 'uppercase' }}>
          DAI VITA AL<br />TUO TOTEM
        </h1>
        <div style={{ color: '#D8C3A6', fontSize: 15, marginTop: 12 }}>Scegli un nome. Ti seguirà tutta la serata.</div>

        <div style={{ marginTop: 26 }}>
          <label htmlFor="guest-nome" className="tag" style={{ display: 'block', letterSpacing: '.2em', fontSize: 11, color: '#A58A66', marginBottom: 8 }}>
            IL TUO NOME
          </label>
          <input
            id="guest-nome"
            name="nome"
            type="text"
            autoComplete="given-name"
            required
            placeholder="Come ti chiami?"
            value={nome}
            onChange={(e) => onNome(e.target.value)}
            style={{
              width: '100%',
              height: 58,
              borderRadius: 12,
              background: '#2A1A11',
              border: '1.5px solid #3A5BBE',
              boxShadow: '0 0 0 4px rgba(58,91,190,.12)',
              padding: '0 18px',
              fontSize: 18,
              fontFamily: 'var(--font-ui)',
              color: '#fff',
              outline: 'none',
            }}
          />
        </div>

        {/* consenso (G2) */}
        <label htmlFor="guest-tos" style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 18, cursor: 'pointer' }}>
          <input
            id="guest-tos"
            name="tos"
            type="checkbox"
            checked={accettato}
            onChange={(e) => onAccettato(e.target.checked)}
            style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
          />
          <span
            aria-hidden="true"
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              border: `2px solid ${accettato ? '#3A5BBE' : '#5A3826'}`,
              background: accettato ? '#3A5BBE' : 'transparent',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              fontSize: 15,
            }}
          >
            {accettato ? '✓' : ''}
          </span>
          <span style={{ fontSize: 14.5, color: '#F3E7D4', lineHeight: 1.4 }}>
            Ho letto e accetto i{' '}
            <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#D89A3E', textDecoration: 'underline' }}>
              Termini &amp; Condizioni
            </a>
            .
          </span>
        </label>

        {errore && (
          <div style={{ marginTop: 16, background: '#2A1A11', border: '1px solid #EE6321', borderRadius: 12, padding: 14, fontSize: 14, color: '#fff' }}>
            {errore}
          </div>
        )}
      </div>

      <div style={{ position: 'relative', marginTop: 'auto', padding: '24px 30px max(40px, env(safe-area-inset-bottom))' }}>
        <button
          type="submit"
          disabled={!canSubmit}
          className="btn"
          style={{
            width: '100%',
            height: 56,
            borderRadius: 14,
            background: '#3A5BBE',
            color: '#fff',
            border: 'none',
            fontWeight: 600,
            fontSize: 16,
            fontFamily: 'var(--font-ui)',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            opacity: canSubmit ? 1 : 0.5,
            boxShadow: '0 0 24px rgba(58,91,190,.4)',
          }}
        >
          {submitting ? 'Entro…' : 'Entra'}
        </button>
        <div style={{ textAlign: 'center', color: '#A58A66', fontSize: 12, marginTop: 14 }}>Nessuna app da installare</div>
      </div>

      {igniting && <IgniteOverlay level={igniteLevel} phase={ignitePhase} reduced={reducedMotion} />}
    </form>
  );
}
