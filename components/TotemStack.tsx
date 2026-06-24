'use client';

// TotemStack — palo di maschere tiki impilate che si "carica" dal basso.
// Concept design system §0: il totem = "maschere impilate" (demo sostituibile).
// L'energia sale (--tt-fill 0→100%): ogni segmento passa da spento (desaturato)
// ad acceso (pieno colore + glow viola). Scintille d'ambra/oro alla carica alta.
//
// Sostituibile: cambia DEFAULT_STACK (o passa `masks`) per altri asset.
// Nessuna logica di dominio qui: riceve `level` (0–6) o `charge` (0–1) già risolti.
//
// API:
//   <TotemStack level={4} />            livello 0–6 (home ospite G3)
//   <TotemStack charge={0.42} />        carica esplicita 0–1
//   <TotemStack loading />              splash S1: carica in loop 0→100% + anello
import React from 'react';

export type TotemMask = { src: string; scale?: number };

// Set di default (top→base). scale = taper del palo. Swappabile.
export const DEFAULT_STACK: TotemMask[] = [
  { src: '/totem/tiki_r1c4.png', scale: 0.84 }, // corona fogliata
  { src: '/totem/tiki_r2c3.png', scale: 0.95 }, // volto centrale (corna)
  { src: '/totem/tiki_r3c5.png', scale: 1.06 }, // base larga
];

type Props = {
  level?: number; // 0–6 (mappato su totem_level())
  charge?: number; // 0–1, sovrascrive il mapping da level
  loading?: boolean; // splash: carica auto-loop + anello
  size?: number; // larghezza palo in px
  masks?: TotemMask[];
  showRing?: boolean; // forza/disabilita anello di carica
};

export default function TotemStack({
  level,
  charge,
  loading = false,
  size = 200,
  masks = DEFAULT_STACK,
  showRing,
}: Props) {
  const lvl =
    level == null ? null : Math.max(0, Math.min(6, Math.round(level)));
  const c =
    charge != null
      ? Math.max(0, Math.min(1, charge))
      : lvl != null
        ? lvl / 6
        : 0;

  const fillPct = `${Math.round(c * 100)}%`;
  const glow = 0.12 + c * 0.7;
  const sparks = c >= 0.66 ? (c >= 0.95 ? 8 : 4) : 0;
  const sparkColor = c >= 0.95 ? 'var(--gold)' : 'var(--ember)';
  const ring = showRing ?? loading;
  const effLevel = lvl ?? c * 6; // per accendere gli anelli tribali

  const aria = loading
    ? 'Totem in carica'
    : lvl != null
      ? `Totem livello ${lvl} di 6`
      : `Totem carica ${Math.round(c * 100)}%`;

  const Stack = ({ variant }: { variant: 'base' | 'lit' }) => (
    <div className={`tt-stack tt-stack--${variant}`} aria-hidden="true">
      {masks.map((m, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={i}
          src={m.src}
          alt=""
          className="tt-seg"
          draggable={false}
          style={{
            width: `${(m.scale ?? 1) * 100}%`,
            marginTop: i === 0 ? 0 : '-6%',
          }}
        />
      ))}
    </div>
  );

  return (
    <div
      role="img"
      aria-label={aria}
      className={`tt${loading ? ' tt--loading' : ''}`}
      style={
        {
          width: size,
          // in loading la fill è guidata dal keyframe → non forzarla inline
          ...(loading ? {} : { '--tt-fill': fillPct }),
          '--tt-glow': glow,
        } as React.CSSProperties
      }
    >
      <span className="tt-glow" aria-hidden="true" />

      {[0, 1, 2].map((r) => {
        const d = size * (1.15 - r * 0.18);
        const active = effLevel >= (r + 1) * 2 - 1;
        return (
          <span
            key={r}
            className="tt-ring"
            aria-hidden="true"
            style={{
              width: d,
              height: d,
              opacity: active ? 0.18 + c * 0.22 : 0.05,
            }}
          />
        );
      })}

      <div className="tt-stage">
        <div className="tt-pole" style={{ width: size }}>
          <Stack variant="base" />
          <Stack variant="lit" />
          <span className="tt-energy" aria-hidden="true" />
          {Array.from({ length: sparks }).map((_, i) => (
            <span
              key={i}
              className="tt-spark"
              aria-hidden="true"
              style={{
                left: `${15 + (i * 70) / Math.max(1, sparks - 1)}%`,
                animationDelay: `${i * 0.22}s`,
                background: sparkColor,
                boxShadow: `0 0 6px 2px ${sparkColor}`,
              }}
            />
          ))}
        </div>
      </div>

      {ring && <LoaderRing charge={c} loading={loading} size={size * 0.5} />}
    </div>
  );
}

// Anello di caricamento (splash S1). In loading: spin keyframe; altrimenti = carica.
function LoaderRing({
  charge,
  loading,
  size,
}: {
  charge: number;
  loading: boolean;
  size: number;
}) {
  const stroke = 5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = loading ? circ : circ * (1 - charge);
  return (
    <svg
      className="tt-loader"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      style={{ '--tt-circ': `${circ}px` } as React.CSSProperties}
    >
      <defs>
        <linearGradient id="tt-loader-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--eden-violet)" />
          <stop offset="100%" stopColor="var(--gold)" />
        </linearGradient>
      </defs>
      <circle
        className="tt-loader-track"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
      />
      <circle
        className="tt-loader-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeDasharray={circ}
        strokeDashoffset={offset}
      />
    </svg>
  );
}
