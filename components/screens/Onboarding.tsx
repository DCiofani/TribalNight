// G1 — Onboarding nome (+ consenso T&C). Porting fedele dal mockup Claude.
// Presentazionale: form state e submit arrivano come prop (logica nella page).
'use client';

import React from 'react';
import Totem from '@/components/Totem';

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
  // il livello che sale arriva dalla page, qui lo mostriamo soltanto.
  igniting?: boolean;
  igniteLevel?: number;
};

// Keyframe locali per l'overlay rituale (il Totem porta i propri).
const IGNITE_KEYFRAMES = `
@keyframes tmx-ignite-veil { from { opacity: 0 } to { opacity: 1 } }
@keyframes tmx-ignite-rise { 0% { opacity: 0; transform: translateY(10px) } 100% { opacity: 1; transform: translateY(0) } }
`;

function IgniteOverlay({ level }: { level: number }) {
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
        animation: 'tmx-ignite-veil .35s ease-out both',
      }}
    >
      <style>{IGNITE_KEYFRAMES}</style>
      {/* Il Totem prende vita: level sale 0→6, glow progressivo + tmx-awake sulle maschere. */}
      <Totem level={level} size={210} />
      <div style={{ textAlign: 'center', animation: 'tmx-ignite-rise .5s ease-out both' }}>
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
          }}
        >
          IL TUO TOTEM<br />PRENDE VITA
        </h2>
        <div style={{ marginTop: 12, color: '#D89A3E', fontSize: 13, letterSpacing: '.2em', textTransform: 'uppercase' }}>
          La serata è tua
        </div>
      </div>
    </div>
  );
}

export default function Onboarding({ nome, onNome, accettato, onAccettato, submitting, errore, canSubmit, onSubmit, igniting = false, igniteLevel = 0 }: Props) {
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

      {igniting && <IgniteOverlay level={igniteLevel} />}
    </form>
  );
}
