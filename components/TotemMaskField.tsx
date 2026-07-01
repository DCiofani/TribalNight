// Campo di maschere tribali fluttuanti — sfondo del totem.
// Quante appaiono E il loro colore seguono il livello (0–7). Iridescenti dal lvl 5.
// Porting fedele dal mockup Claude (buildMaskField).
'use client';

import React from 'react';
import { TOTEM_MASKS } from '@/lib/totem-masks';

function fireRgb(i: number, t: number): [number, number, number] {
  const BASE = [255, 214, 120];
  const TGT = [
    [255, 200, 90],
    [245, 158, 46],
    [235, 108, 42],
    [224, 74, 40],
    [255, 182, 78],
  ];
  const T = TGT[i % TGT.length];
  return BASE.map((v, k) => Math.round(v + (T[k] - v) * t)) as [number, number, number];
}

const rgb = (a: number[]) => `rgb(${a[0]},${a[1]},${a[2]})`;
const rgba = (a: number[], al: number) => `rgba(${a[0]},${a[1]},${a[2]},${al})`;

const SPOTS = [
  { l: '3%', t: '13%', s: 58, rot: -12, dur: 7.5, d: 0.0 },
  { l: '79%', t: '9%', s: 66, rot: 10, dur: 8.6, d: 1.1 },
  { l: '1%', t: '41%', s: 48, rot: 7, dur: 6.8, d: 0.5 },
  { l: '84%', t: '35%', s: 54, rot: -9, dur: 9.0, d: 1.7 },
  { l: '5%', t: '67%', s: 60, rot: -6, dur: 7.9, d: 0.8 },
  { l: '81%', t: '63%', s: 52, rot: 12, dur: 8.3, d: 0.2 },
  { l: '15%', t: '3%', s: 42, rot: 9, dur: 7.1, d: 2.2 },
  { l: '67%', t: '2%', s: 46, rot: -11, dur: 8.0, d: 1.4 },
  { l: '9%', t: '85%', s: 50, rot: 5, dur: 6.6, d: 0.9 },
  { l: '73%', t: '86%', s: 56, rot: -14, dur: 9.3, d: 1.9 },
  { l: '-3%', t: '27%', s: 40, rot: 14, dur: 7.3, d: 2.6 },
  { l: '88%', t: '49%', s: 44, rot: -5, dur: 6.9, d: 0.4 },
  { l: '42%', t: '92%', s: 38, rot: 8, dur: 7.7, d: 1.2 },
  { l: '47%', t: '1%', s: 36, rot: -7, dur: 8.1, d: 2.0 },
  { l: '90%', t: '77%', s: 40, rot: 11, dur: 7.0, d: 0.6 },
];

const KEYFRAMES = `
@keyframes tnx-float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-9px)} }
@keyframes tnx-iris { 0%{filter:hue-rotate(0deg) saturate(1.4)} 100%{filter:hue-rotate(360deg) saturate(1.4)} }
`;

export default function TotemMaskField({ level, className }: { level: number; className?: string }) {
  const colorT = level <= 1 ? 0 : Math.min(1, (level - 1) / 5);
  const activeN = Math.max(0, Math.min(SPOTS.length, Math.round(level * 2.3)));
  const iris = level >= 5;

  return (
    <div
      className={className}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      <style>{KEYFRAMES}</style>
      {SPOTS.map((m, i) => {
        const mk = TOTEM_MASKS[(i * 7 + 3) % TOTEM_MASKS.length];
        const lit = i < activeN;
        const c = fireRgb(i, colorT);
        const lc = [Math.min(255, c[0] + 36), Math.min(255, c[1] + 40), Math.min(255, c[2] + 30)];
        const litOpacity = 0.5 + Math.min(1, (m.s - 34) / 40) * 0.4;
        const glow = (
          <div
            style={{
              width: '100%',
              height: '100%',
              color: lit ? rgb(lc) : 'rgba(150,104,60,.85)',
              filter: lit
                ? `drop-shadow(0 0 2px ${rgba(lc, 0.85)}) drop-shadow(0 0 8px ${rgba(c, 0.7)}) drop-shadow(0 0 17px ${rgba(c, 0.4)})`
                : 'none',
              transition: 'color .6s ease, filter .6s ease',
            }}
            dangerouslySetInnerHTML={{ __html: mk.svg }}
          />
        );
        const irised =
          lit && iris ? (
            <div style={{ width: '100%', height: '100%', animation: `tnx-iris ${6 + (i % 3)}s linear ${i * 0.3}s infinite` }}>
              {glow}
            </div>
          ) : (
            glow
          );
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: m.l,
              top: m.t,
              width: m.s,
              height: m.s * 1.3,
              transform: `rotate(${m.rot}deg)`,
              opacity: lit ? litOpacity : 0.06,
              filter: lit && m.s < 46 ? 'blur(0.4px)' : 'none',
              transition: 'opacity .7s ease, filter .6s ease',
            }}
          >
            <div style={{ width: '100%', height: '100%', animation: `tnx-float ${m.dur}s ease-in-out ${m.d}s infinite` }}>
              {irised}
            </div>
          </div>
        );
      })}
    </div>
  );
}
