// G4 — Mostra alla cassa (QR + PIN). Porting fedele dal mockup Claude.
// Il QR mostrato è un placeholder visivo coerente col design: sostituisci `pattern`
// con il payload firmato reale (TODO M2/M3) quando disponibile.
'use client';

import React from 'react';

// generatore QR "finto" deterministico — identico al mockup (solo presentazione)
function qrSvg(size: number, fg: string, seedStr: string) {
  const n = 21;
  const cell = size / n;
  let r = 7;
  for (let i = 0; i < seedStr.length; i++) r = (r * 31 + seedStr.charCodeAt(i)) & 0x7fffffff;
  const rnd = () => {
    r = (r * 1103515245 + 12345) & 0x7fffffff;
    return r / 0x7fffffff;
  };
  let m = '';
  const finder = (ox: number, oy: number) => {
    m += `<rect x="${ox * cell}" y="${oy * cell}" width="${7 * cell}" height="${7 * cell}" rx="${cell}" fill="${fg}"/>`;
    m += `<rect x="${(ox + 1) * cell}" y="${(oy + 1) * cell}" width="${5 * cell}" height="${5 * cell}" rx="${cell * 0.6}" fill="#fff"/>`;
    m += `<rect x="${(ox + 2) * cell}" y="${(oy + 2) * cell}" width="${3 * cell}" height="${3 * cell}" rx="${cell * 0.4}" fill="${fg}"/>`;
  };
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const inF = (x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12);
      if (inF) continue;
      if (rnd() > 0.52)
        m += `<rect x="${x * cell + cell * 0.08}" y="${y * cell + cell * 0.08}" width="${cell * 0.84}" height="${cell * 0.84}" rx="${cell * 0.28}" fill="${fg}"/>`;
    }
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="100%">${m}</svg>`;
}

type Props = { name?: string; pin?: string; onBack?: () => void };

export default function GuestQR({ name = '', pin = '----', onBack }: Props) {
  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100dvh',
        color: '#fff',
        fontFamily: 'var(--font-ui)',
        background: 'radial-gradient(90% 60% at 50% 42%, rgba(58,91,190,.22) 0%, transparent 60%), #160C06',
      }}
    >
      <div style={{ padding: 'max(54px, calc(env(safe-area-inset-top) + 18px)) 22px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          onClick={onBack}
          style={{ width: 38, height: 38, borderRadius: 11, border: '1px solid #43291A', background: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#D8C3A6', cursor: 'pointer', fontSize: 18 }}
        >
          ‹
        </button>
        <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.2em', fontSize: 12, color: '#A58A66' }}>MOSTRA QUESTO</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '46px 22px 0' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, letterSpacing: '.04em' }}>{name || '\u2014'}</div>
        <div
          style={{
            marginTop: 30,
            width: 264,
            height: 264,
            maxWidth: '78vw',
            background: '#fff',
            borderRadius: 24,
            padding: 22,
            boxShadow: '0 0 60px rgba(58,91,190,.55)',
            border: '1px solid #D89A3E',
          }}
          dangerouslySetInnerHTML={{ __html: qrSvg(220, '#231405', (name || '') + (pin || '')) }}
        />
        <div style={{ marginTop: 40, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.18em', fontSize: 11, color: '#A58A66' }}>PIN (FALLBACK)</div>
          <div style={{ fontFamily: 'var(--font-ritual)', fontWeight: 700, fontSize: 46, letterSpacing: '.32em', color: '#F2B43C', marginTop: 6, paddingLeft: '.32em' }}>
            {pin}
          </div>
        </div>
        <div style={{ marginTop: 28, maxWidth: 320, textAlign: 'center', color: '#D8C3A6', fontSize: 14 }}>
          Mostralo alla cassa per ricaricare o ordinare.
        </div>
      </div>
    </div>
  );
}
