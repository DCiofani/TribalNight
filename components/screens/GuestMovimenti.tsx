// G6 — Movimenti. Porting fedele dal mockup Claude. Presentazionale.
'use client';

import React from 'react';

export type Tx = {
  icon: string;
  iconBg: string;
  label: string;
  time: string;
  delta: string;
  deltaColor: string;
};

type Props = {
  ticket?: number | string;
  consumazioni?: string;
  tx?: Tx[];
  onBack?: () => void;
};

export default function GuestMovimenti({ ticket = '—', consumazioni = '—', tx = [], onBack }: Props) {
  return (
    <div style={{ position: 'relative', minHeight: '100dvh', color: '#fff', fontFamily: 'var(--font-ui)', background: '#160C06' }}>
      <div style={{ padding: 'max(54px, calc(env(safe-area-inset-top) + 18px)) 22px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          onClick={onBack}
          style={{ width: 38, height: 38, borderRadius: 11, border: '1px solid #43291A', background: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#D8C3A6', cursor: 'pointer', fontSize: 18 }}
        >
          ‹
        </button>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, letterSpacing: '.04em' }}>MOVIMENTI</div>
      </div>

      <div style={{ display: 'flex', gap: 12, padding: '18px 22px 0' }}>
        <div style={{ flex: 1, background: 'rgba(242,180,60,.08)', border: '1px solid rgba(242,180,60,.3)', borderRadius: 12, padding: 12 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: '#F2B43C' }}>{ticket}</div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', color: '#F2B43C' }}>TICKET</div>
        </div>
        <div style={{ flex: 1, background: '#2A1A11', border: '1px solid #43291A', borderRadius: 12, padding: 12 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>{consumazioni}</div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', color: '#A58A66' }}>CONSUMAZIONI</div>
        </div>
      </div>

      <div style={{ padding: '18px 22px 40px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tx.map((t, i) => (
          <div key={i} style={{ background: '#2A1A11', border: '1px solid #43291A', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: t.iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}>{t.icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14 }}>{t.label}</div>
              <div style={{ fontSize: 11, color: '#A58A66' }}>{t.time}</div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: t.deltaColor }}>{t.delta}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
