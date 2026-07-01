// G3 — Home / Totem (HUB). Porting FEDELE dal mockup Claude.
// Presentazionale: riceve i dati come prop (i tuoi hook restano nella page).
'use client';

import React from 'react';
import Totem from '@/components/Totem';
import TotemMaskField from '@/components/TotemMaskField';

type Tab = 'totem' | 'menu' | 'movimenti';

type Props = {
  name?: string;
  ticket?: number | string;
  normali?: number | string;
  premium?: number | string;
  level: number;
  seed?: number;
  active?: Tab;
  onShowCassa?: () => void;
  onNav?: (tab: Tab) => void;
};

export default function GuestHome({
  name = '',
  ticket = '—',
  normali = '—',
  premium = '—',
  level,
  seed,
  active = 'totem',
  onShowCassa,
  onNav,
}: Props) {
  const lvl = Math.max(0, Math.min(6, Math.round(level || 0)));

  const dockItem = (key: Tab, label: string) => {
    const on = active === key;
    const col = on ? '#D89A3E' : '#7E6A52';
    return (
      <button
        onClick={() => onNav?.(key)}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          color: col,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <span style={{ width: 22, height: 22, border: `2px solid ${col}`, borderRadius: 6 }} />
        <span style={{ fontSize: 11, letterSpacing: '.08em' }}>{label}</span>
      </button>
    );
  };

  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'var(--font-ui)',
        background:
          'radial-gradient(120% 75% at 50% 36%, rgba(58,91,190,.14) 0%, transparent 60%), radial-gradient(130% 90% at 50% 32%, #2C1B12 0%, #160C06 64%)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'repeating-radial-gradient(circle at 50% 40%, rgba(212,150,70,.05) 0 1px, transparent 1px 46px)',
        }}
      />
      <TotemMaskField level={lvl} />

      {/* header */}
      <div
        style={{
          position: 'relative',
          padding: 'max(54px, calc(env(safe-area-inset-top) + 18px)) 22px 0',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.2em', fontSize: 11, color: '#A58A66' }}>
            BENTORNATO
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, letterSpacing: '.02em' }}>
            {name || '\u2014'}
          </div>
        </div>
        <div
          style={{
            background: 'rgba(242,180,60,.1)',
            border: '1px solid rgba(242,180,60,.4)',
            borderRadius: 14,
            padding: '8px 14px',
            textAlign: 'right',
          }}
        >
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: '#F2B43C', lineHeight: 1 }}>{ticket}</div>
          <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.2em', fontSize: 10, color: '#F2B43C' }}>TICKET</div>
        </div>
      </div>

      {/* saldo chips */}
      <div style={{ position: 'relative', padding: '14px 22px 0', display: 'flex', gap: 12 }}>
        <div
          style={{
            flex: 1,
            background: '#2A1A11',
            border: '1px solid #43291A',
            borderRadius: 12,
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ width: 30, height: 30, borderRadius: 8, background: '#3A2414', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>🥃</div>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>{normali}</div>
            <div style={{ fontSize: 10, color: '#A58A66', letterSpacing: '.12em' }}>NORMALI</div>
          </div>
        </div>
        <div
          style={{
            flex: 1,
            background: '#2A1A11',
            border: '1px solid #5E83CE66',
            borderRadius: 12,
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            boxShadow: '0 0 16px rgba(212,150,70,.12)',
          }}
        >
          <div style={{ width: 30, height: 30, borderRadius: 8, background: '#22315C', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>🍸</div>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: '#9BB6EC' }}>{premium}</div>
            <div style={{ fontSize: 10, color: '#D89A3E', letterSpacing: '.12em' }}>PREMIUM</div>
          </div>
        </div>
      </div>

      {/* hero totem */}
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 380, padding: '8px 0' }}>
        <Totem level={lvl} seed={seed} size={260} />
        <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.28em', fontSize: 13, color: '#9BB6EC', marginTop: 8 }}>
          LIVELLO {lvl} · TOTEM VIVO
        </div>
      </div>

      {/* CTA */}
      <div style={{ position: 'relative', padding: '0 22px 14px' }}>
        <button
          onClick={onShowCassa}
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
            gap: 10,
            fontWeight: 600,
            fontSize: 16,
            fontFamily: 'var(--font-ui)',
            cursor: 'pointer',
            boxShadow: '0 0 26px rgba(58,91,190,.45)',
          }}
        >
          <span style={{ width: 18, height: 18, border: '2px solid #fff', borderRadius: 5, display: 'inline-block' }} />
          Mostra alla cassa
        </button>
      </div>

      {/* dock */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          height: 80,
          paddingBottom: 'env(safe-area-inset-bottom)',
          background: 'rgba(22,13,7,.92)',
          borderTop: '1px solid #43291A',
          display: 'flex',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        {dockItem('totem', 'Totem')}
        {dockItem('menu', 'Menù')}
        {dockItem('movimenti', 'Movimenti')}
      </div>
    </div>
  );
}
