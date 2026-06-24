// TEMP — swappabile quando arriva il design (Claude Design).
// Tile statistica: label (.tag) + valore grande. Il front-end NON calcola:
// i valori arrivano come prop (placeholder "—"/0 marcati TODO(RPC)/TODO(realtime)).
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
  const accent: Record<StatTone, { border: string; value: string }> = {
    normale: { border: 'var(--night-700)', value: 'var(--ink-0)' },
    premium: { border: 'var(--eden-violet)', value: 'var(--eden-lavender)' },
    gold: { border: 'var(--gold)', value: 'var(--gold)' },
  };

  const { border, value: valueColor } = accent[tone];

  return (
    <div
      className="card"
      style={{
        borderColor: border,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <p className="tag">{label}</p>
      <span style={{ fontSize: 32, fontWeight: 700, lineHeight: 1, color: valueColor }}>
        {value}
      </span>
    </div>
  );
}
