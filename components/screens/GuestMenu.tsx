// G5 — Menù. Porting fedele dal mockup Claude. Presentazionale.
'use client';

import React from 'react';

export type MenuItem = {
  name: string;
  desc: string;
  swatch: string; // CSS background del thumbnail
  tag: string;
  tagColor: string;
  tagBorder: string;
};

type Props = {
  items?: MenuItem[];
  categories?: string[];
  activeCat?: string;
  // Avviso di stato dal server (es. bar chiuso in LAST_CALL/ESTRAZIONE/CHIUSA).
  // null/undefined => bar aperto, nessun banner e voci a piena opacità.
  // La fase NON viene mai ricalcolata qui: la page la riceve dal backend.
  notice?: string | null;
  onBack?: () => void;
  onCat?: (c: string) => void;
};

const DEFAULT_CATS = ['Tutti', 'Cocktail', 'Birre', 'Soft'];

export default function GuestMenu({ items = [], categories = DEFAULT_CATS, activeCat = 'Tutti', notice, onBack, onCat }: Props) {
  return (
    <div style={{ position: 'relative', minHeight: '100dvh', color: '#fff', fontFamily: 'var(--font-ui)', background: '#160C06' }}>
      <div style={{ padding: 'max(54px, calc(env(safe-area-inset-top) + 18px)) 22px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          onClick={onBack}
          style={{ width: 38, height: 38, borderRadius: 11, border: '1px solid #43291A', background: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#D8C3A6', cursor: 'pointer', fontSize: 18 }}
        >
          ‹
        </button>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, letterSpacing: '.04em' }}>MENÙ</div>
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '18px 22px 0', overflowX: 'auto' }}>
        {categories.map((c) => {
          const on = c === activeCat;
          return (
            <button
              key={c}
              onClick={() => onCat?.(c)}
              style={{
                flexShrink: 0,
                background: on ? '#3A5BBE' : '#2A1A11',
                color: on ? '#fff' : '#D8C3A6',
                border: on ? 'none' : '1px solid #43291A',
                borderRadius: 99,
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: on ? 600 : 400,
                fontFamily: 'var(--font-ui)',
                cursor: 'pointer',
              }}
            >
              {c}
            </button>
          );
        })}
      </div>

      {/* Banner di FASE: discreto, in palette ember. Appare solo se `notice` è valorizzato
          (bar chiuso). Lo stato arriva dal server: qui nessun ricalcolo. */}
      {notice && (
        <div style={{ padding: '18px 22px 0' }}>
          <div
            role="status"
            style={{
              background: 'rgba(194,69,31,.1)',
              border: '1px solid rgba(216,154,62,.45)',
              borderRadius: 12,
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span style={{ fontSize: 16, flexShrink: 0 }}>⚠</span>
            <span style={{ fontSize: 13, color: '#E0C39B', lineHeight: 1.35 }}>{notice}</span>
          </div>
        </div>
      )}

      <div style={{ padding: '20px 22px 40px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {items.map((d, i) => (
          <div key={i} style={{ background: '#2A1A11', border: '1px solid #43291A', borderRadius: 16, padding: 14, display: 'flex', alignItems: 'center', gap: 14, opacity: notice ? 0.55 : 1 }}>
            <div style={{ width: 56, height: 56, borderRadius: 12, background: d.swatch, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{d.name}</div>
              <div style={{ fontSize: 12.5, color: '#A58A66', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.desc}</div>
            </div>
            <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.1em', fontSize: 10, padding: '6px 10px', borderRadius: 8, border: `1px solid ${d.tagBorder}`, color: d.tagColor, flexShrink: 0 }}>
              {d.tag}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
