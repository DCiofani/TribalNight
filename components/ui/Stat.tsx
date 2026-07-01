// Tile statistica: label (.tag) + valore grande. Il front-end NON calcola:
// i valori arrivano come prop. Un sottile bordo-accento a sinistra dà il "tono".
import React from 'react';

type StatTone = 'normale' | 'premium' | 'gold';

export default function Stat({
  label,
  value,
  tone = 'normale',
}: {
  label: string;
  value: React.ReactNode;
  tone?: StatTone;
}) {
  const accent: Record<StatTone, { bar: string; value: string }> = {
    normale: { bar: 'var(--ink-500)', value: 'var(--ink-0)' },
    premium: { bar: 'var(--eden-indigo)', value: '#9db3ec' },
    gold: { bar: 'var(--gold)', value: 'var(--gold)' },
  };

  const { bar, value: valueColor } = accent[tone];

  return (
    <div
      className="card"
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: bar,
          boxShadow: `0 0 12px ${bar}`,
        }}
      />
      <p className="tag">{label}</p>
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 34,
          lineHeight: 1,
          letterSpacing: '0.01em',
          color: valueColor,
        }}
      >
        {value}
      </span>
    </div>
  );
}
