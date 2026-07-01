// ─────────────────────────────────────────────────────────────────────────────
// Totem — asset definitivo (design Claude). DROP-IN del vecchio placeholder:
// stessa firma `({ level })`, quindi guest/cassa/regia/onboarding restano invariati.
//
// Palo di MASCHERE TRIBALI neon impilate che si accende dal basso col livello.
//   level 0   spento (fantasmi bruni)
//   1–3       le maschere si accendono una a una (fuoco oro→ambra), pulsano
//   4         totem pieno · diamante acceso · 1ª maschera iridescente
//   5         scintille d'ambra · le maschere mutano colore
//   6         "in fiamme" · TUTTE le maschere + diamante iridescenti (arcobaleno)
//
// Self-contained: colori e keyframe sono interni (niente dipendenze da globals.css).
// Le maschere sono pescate dal pool con un `seed` deterministico (random-matching).
//
// API:
//   <Totem level={4} />                    // drop-in (come prima)
//   <Totem level={lvl} seed={hashGuest} /> // maschere fisse per-ospite
//   <Totem level={lvl} trunk={false} />    // senza tronco
//   <Totem level={lvl} size={260} />       // larghezza palo in px
import React from 'react';
import { TOTEM_MASKS, TOTEM_MASK_FACES, type FaceBox } from '@/lib/totem-masks';

type Props = {
  level: number;
  seed?: number;
  trunk?: boolean;
  size?: number; // larghezza del palo in px (l'altezza segue il rapporto 280:584)
  className?: string;
};

const BW = 280;
const BH = 584;
const DEF_FACE: FaceBox = [0.15, 0.18, 0.7, 0.6];

// PRNG deterministico (mulberry32) → stesso seed ⇒ stesso totem (SSR-safe, no mismatch).
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// pesca `n` maschere variando i volti; preferisce quelle "larghe" (≈ larghezza tronco).
function pickMasks(seed: number, n: number) {
  const F = TOTEM_MASK_FACES;
  const r = makeRng(seed);
  const ratio = (id: string, ar: number) => {
    const f = F[id];
    return f ? (ar * f[2]) / f[3] : 1;
  };
  const pool = TOTEM_MASKS.map((_, i) => i);
  const wide = pool.filter((i) => ratio(TOTEM_MASKS[i].id, TOTEM_MASKS[i].ar) >= 0.8);
  const use = (wide.length >= n ? wide : pool).slice();
  for (let i = use.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [use[i], use[j]] = [use[j], use[i]];
  }
  return use.slice(0, n).map((i) => TOTEM_MASKS[i]);
}

// rampa di fuoco coerente (base → apice). Si satura col livello.
function fireRgb(i: number, t: number): [number, number, number] {
  const BASE = [255, 211, 112];
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

const pct = (v: number, base: number) => `${(v / base) * 100}%`;
const rgb = (a: number[]) => `rgb(${a[0]},${a[1]},${a[2]})`;
const rgba = (a: number[], al: number) => `rgba(${a[0]},${a[1]},${a[2]},${al})`;

const KEYFRAMES = `
@keyframes tmx-bob { 0%,100%{ transform:translateY(0) } 50%{ transform:translateY(-5px) } }
@keyframes tmx-sway { 0%,100%{ transform:translateY(0) rotate(-0.7deg) } 50%{ transform:translateY(-6px) rotate(0.7deg) } }
@keyframes tmx-ring { 0%,100%{ transform:translate(-50%,-50%) scale(1); opacity:.5 } 50%{ transform:translate(-50%,-50%) scale(1.07); opacity:.85 } }
@keyframes tmx-spark { 0%{ transform:translateY(8px) scale(.5); opacity:0 } 22%{ opacity:1 } 100%{ transform:translateY(-58px) scale(1.1); opacity:0 } }
@keyframes tmx-gembreathe { 0%,100%{ transform:scale(.965) } 50%{ transform:scale(1.04) } }
@keyframes tmx-glint { 0%,42%,58%,100%{ opacity:0 } 50%{ opacity:.95 } }
@keyframes tmx-awake { 0%{ transform:scale(.86); opacity:.2 } 60%{ transform:scale(1.05) } 100%{ transform:scale(1); opacity:1 } }
@keyframes tmx-iris { 0%{ filter:hue-rotate(0deg) saturate(1.45) } 100%{ filter:hue-rotate(360deg) saturate(1.45) } }
@keyframes tmx-soul { 0%{ opacity:.5 } 20%{ opacity:1 } 46%{ opacity:.92 } 50%{ opacity:.22 } 54%{ opacity:.95 } 78%{ opacity:1 } 100%{ opacity:.5 } }
`;

export default function Totem({ level, seed = 7, trunk = true, size = 240, className }: Props) {
  const lvl = Math.max(0, Math.min(6, Math.round(level)));

  // colonna di 4 volti, centrati sull'asse, leggermente rastremati (più grandi in basso).
  const slots = [
    { cy: 492, fh: 130, rot: -2 },
    { cy: 372, fh: 122, rot: 2 },
    { cy: 256, fh: 114, rot: -2 },
    { cy: 150, fh: 104, rot: 1 },
  ];
  const masks = pickMasks(seed, slots.length);

  const litCount = Math.min(lvl, slots.length);
  const colorT = lvl <= 1 ? 0 : Math.min(1, (lvl - 1) / 5);
  const crownLit = lvl >= 4;
  const gemHot = lvl >= 6;
  const sparksOn = lvl >= 5;
  const flames = lvl >= 6;
  const floatAnim = lvl >= 1;
  const auraO = [0, 0.1, 0.16, 0.24, 0.34, 0.44, 0.56][lvl];
  const topRgb = fireRgb(litCount > 0 ? litCount - 1 : 0, colorT);

  const irisN = lvl >= 6 ? litCount : lvl >= 5 ? 3 : lvl >= 4 ? 1 : 0;
  const irisDur = lvl >= 6 ? 5 : lvl >= 5 ? 6.5 : 9;

  // ---- maschere impilate ----
  const maskEls = slots.map((s, i) => {
    const m = masks[i % masks.length];
    const lit = i < litCount;
    const c = fireRgb(i, colorT);
    const [fx, fy, fw, fh] = TOTEM_MASK_FACES[m.id] || DEF_FACE;
    let contH = s.fh / fh;
    let contW = contH * m.ar;
    const MAXW = 178;
    const faceWpx = contW * fw;
    if (faceWpx > MAXW) {
      const k = MAXW / faceWpx;
      contH *= k;
      contW *= k;
    }
    const faceCx = fx + fw / 2;
    const faceCy = fy + fh / 2;
    const left = (BW / 2) - faceCx * contW;
    const top = s.cy - faceCy * contH;
    const dur = 4.6 + (i % 3) * 0.5;
    const delay = i * 0.4;
    const rank = litCount - 1 - i;
    const iris = lit && rank < irisN;
    const irisDelay = -(i / Math.max(1, litCount)) * irisDur;
    const lc = [Math.min(255, c[0] + 40), Math.min(255, c[1] + 42), Math.min(255, c[2] + 30)];

    const outerStyle: React.CSSProperties = {
      position: 'absolute',
      width: pct(contW, BW),
      height: pct(contH, BH),
      left: pct(left, BW),
      top: pct(top, BH),
      transform: `rotate(${s.rot}deg)`,
      transformOrigin: `${faceCx * 100}% ${faceCy * 100}%`,
      transition: 'opacity .6s ease',
      opacity: lit ? 1 : 0.3,
      zIndex: slots.length - i,
    };
    const soulStyle: React.CSSProperties = {
      position: 'absolute',
      left: `${(fx - 0.01) * 100}%`,
      top: `${(fy - 0.01) * 100}%`,
      width: `${(fw + 0.02) * 100}%`,
      height: `${(fh + 0.04) * 100}%`,
      background: `radial-gradient(closest-side, rgba(255,245,216,0.82) 0%, ${rgba(c, 0.6)} 36%, ${rgba(c, 0.3)} 58%, ${rgba(c, 0.1)} 76%, transparent 86%)`,
      filter: 'blur(1.5px)',
      zIndex: 0,
      pointerEvents: 'none',
      animation: `tmx-soul ${4 + (i % 3) * 0.5}s ease-in-out ${i * 0.5}s infinite`,
    };
    const maskStyle: React.CSSProperties = {
      position: 'absolute',
      inset: 0,
      zIndex: 1,
      color: lit ? rgb(lc) : 'rgba(150,102,56,.5)',
      filter: lit
        ? flames
          ? `drop-shadow(0 0 3px rgba(255,243,214,0.95)) drop-shadow(0 0 10px ${rgba(c, 0.85)}) drop-shadow(0 0 22px ${rgba(c, 0.55)}) drop-shadow(0 0 38px ${rgba(c, 0.4)})`
          : `drop-shadow(0 0 2.5px rgba(255,243,214,0.9)) drop-shadow(0 0 8px ${rgba(c, 0.8)}) drop-shadow(0 0 18px ${rgba(c, 0.5)})`
        : 'none',
      transition: 'color .6s ease, filter .6s ease',
    };
    const bobStyle: React.CSSProperties = {
      position: 'absolute',
      inset: 0,
      animation: floatAnim
        ? `tmx-bob ${dur}s ease-in-out ${delay}s infinite${lit ? ', tmx-awake 0.9s ease-out' : ''}`
        : 'none',
      transformOrigin: 'center bottom',
    };
    const irisStyle: React.CSSProperties = {
      position: 'absolute',
      inset: 0,
      animation: iris ? `tmx-iris ${irisDur}s linear ${irisDelay}s infinite` : 'none',
    };

    return (
      <div key={i} style={outerStyle}>
        <div style={irisStyle}>
          <div style={bobStyle}>
            {lit && <div style={soulStyle} />}
            <div style={maskStyle} dangerouslySetInnerHTML={{ __html: m.svg }} />
          </div>
        </div>
      </div>
    );
  });

  // ---- diamante (minimal, animato) ----
  const gs = crownLit ? rgba(fireRgb(4, colorT), 0.95) : 'rgba(150,102,56,.55)';
  const gemFill = crownLit ? rgba(fireRgb(3, colorT), 0.28) : 'rgba(120,80,40,.12)';
  const gemSvg = `<svg viewBox="0 0 80 80" width="100%" height="100%" style="overflow:visible">
      <path d="M40 9 L62 40 L40 71 L18 40 Z" fill="${gemFill}" stroke="${gs}" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M18 40 L40 24 L62 40" fill="none" stroke="${gs}" stroke-width="1.5" opacity=".8"/>
      <path d="M40 24 L40 71 M28.5 40 L40 71 L51.5 40" fill="none" stroke="${gs}" stroke-width="1.3" opacity=".55"/>
      ${gemHot ? '<circle cx="40" cy="44" r="6" fill="#fff6df"/>' : ''}
    </svg>`;
  const gemIris = lvl >= 5;
  const crownStyle: React.CSSProperties = {
    position: 'absolute',
    width: pct(108, BW),
    height: pct(108, BH),
    left: pct(BW / 2 - 54, BW),
    top: pct(0, BH),
    zIndex: 22,
    filter: crownLit
      ? `drop-shadow(0 0 9px ${rgba(fireRgb(3, colorT), 0.95)}) drop-shadow(0 0 26px ${rgba(fireRgb(4, colorT), 0.6)})`
      : 'none',
    transition: 'filter .6s ease',
    animation: floatAnim ? 'tmx-bob 5.2s ease-in-out infinite' : 'none',
  };

  // ---- tronco intagliato ----
  const glowA = Math.min(litCount / 5, 1);
  const rimT = litCount > 0 ? `rgba(222,160,82,${0.16 + glowA * 0.16})` : 'rgba(120,80,40,.32)';
  const inlay = `rgba(255,176,72,${0.1 + glowA * 0.3})`;
  const ember = rgb(topRgb);
  const trunkSvg = `<svg viewBox="0 0 280 584" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="overflow:visible">
      <defs>
        <linearGradient id="tmx-wood" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#140b05"/><stop offset="0.32" stop-color="#37210f"/>
          <stop offset="0.52" stop-color="#482c16"/><stop offset="0.72" stop-color="#2b190d"/><stop offset="1" stop-color="#110805"/>
        </linearGradient>
        <linearGradient id="tmx-core" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(255,178,82,${0.05 + glowA * 0.16})"/>
          <stop offset="0.5" stop-color="rgba(255,138,52,${0.08 + glowA * 0.22})"/>
          <stop offset="1" stop-color="rgba(255,168,72,${0.04 + glowA * 0.14})"/>
        </linearGradient>
      </defs>
      <ellipse cx="140" cy="572" rx="84" ry="13" fill="rgba(0,0,0,.5)"/>
      <g fill="none" stroke="${rimT}" stroke-width="2.6" opacity=".4" stroke-linecap="round">
        <path d="M104 556 Q78 572 54 564"/><path d="M176 556 Q202 572 226 564"/><path d="M140 560 Q139 575 137 582"/>
      </g>
      <path d="M108 102 Q140 88 172 102 L194 560 Q140 580 86 560 Z" fill="url(#tmx-wood)" stroke="${rimT}" stroke-width="1.5"/>
      <path d="M116 108 Q140 98 164 108 L182 556 Q140 572 98 556 Z" fill="url(#tmx-core)"/>
      <path d="M104 108 Q120 99 130 105 L118 556 Q108 560 98 556 Z" fill="rgba(255,205,130,.05)"/>
      <g fill="none" stroke="${rimT}" stroke-width="1.7" opacity=".34">
        <path d="M110 116 Q140 127 170 116"/><path d="M113 127 Q140 136 167 127"/>
      </g>
      <g fill="${ember}" opacity="${0.3 + glowA * 0.4}"><path d="M140 120 l6 8 -6 8 -6 -8z"/></g>
      <g fill="none" stroke="${inlay}" stroke-width="1.5" opacity=".34" stroke-linejoin="round">
        ${[170, 252, 334, 414, 492]
          .map((y, k) =>
            k % 2 === 0
              ? `<path d="M128 ${y} L140 ${y - 8} L152 ${y} M128 ${y + 8} L140 ${y} L152 ${y + 8}"/>`
              : `<path d="M140 ${y - 9} L151 ${y} L140 ${y + 9} L129 ${y} Z"/>`
          )
          .join('')}
      </g>
      <g fill="none" stroke="${rimT}" stroke-width="1.3" opacity=".24">
        <path d="M106 150 Q140 160 174 150"/><path d="M184 520 Q140 534 96 520"/>
      </g>
    </svg>`;

  // ---- aura + anelli ----
  const auraStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '48%',
    width: '94%',
    height: '84%',
    transform: 'translate(-50%,-50%)',
    background: `radial-gradient(closest-side, ${rgba(topRgb, flames ? 0.5 : 0.32)} 0%, ${rgba(topRgb, 0.14)} 46%, transparent 76%)`,
    opacity: auraO,
    pointerEvents: 'none',
    zIndex: 0,
    animation: lvl >= 4 ? 'tmx-ring 3.6s ease-in-out infinite' : 'none',
  };
  const ringStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 0,
    opacity: (trunk ? 0.025 : 0.1) + auraO * (trunk ? 0.05 : 0.22),
    pointerEvents: 'none',
  };
  const ringSvg = `<svg viewBox="0 0 280 584" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="overflow:visible">
      <g fill="none" stroke="#F2B43C" stroke-width="1">
        <ellipse cx="140" cy="292" rx="124" ry="210"/><ellipse cx="140" cy="292" rx="94" ry="166"/><ellipse cx="140" cy="292" rx="64" ry="122"/>
      </g></svg>`;

  // ---- scintille ----
  const sparkPts = flames
    ? [[20, 72], [80, 68], [14, 50], [86, 46], [26, 30], [74, 32], [50, 16], [36, 84], [64, 86], [50, 40]]
    : [[22, 70], [78, 66], [16, 52], [84, 48], [50, 30]];
  const sparkEls = sparksOn
    ? sparkPts.map((p, i) => {
        const c = i % 2 === 0 ? topRgb : fireRgb(2, colorT);
        const st: React.CSSProperties = {
          position: 'absolute',
          left: `${p[0]}%`,
          top: `${p[1]}%`,
          width: 5 + (i % 3) * 2,
          height: 5 + (i % 3) * 2,
          borderRadius: '50%',
          background: rgb(c),
          boxShadow: `0 0 7px ${rgba(c, 0.9)}`,
          zIndex: 18,
          pointerEvents: 'none',
          animation: `tmx-spark ${1.7 + (i % 4) * 0.35}s ease-in ${i * 0.18}s infinite`,
        };
        return <div key={`sp${i}`} style={st} />;
      })
    : [];

  const innerStyle: React.CSSProperties = {
    position: 'relative',
    width: size,
    aspectRatio: `${BW} / ${BH}`,
    maxWidth: '100%',
    animation: floatAnim ? 'tmx-sway 7s ease-in-out infinite' : 'none',
    transformOrigin: 'center bottom',
  };

  return (
    <div
      role="img"
      aria-label={`Totem livello ${lvl} di 6`}
      className={className}
      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none' }}
    >
      <style>{KEYFRAMES}</style>
      <div style={innerStyle}>
        <div style={ringStyle} dangerouslySetInnerHTML={{ __html: ringSvg }} />
        {trunk && (
          <div
            style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none', opacity: 0.46 }}
            dangerouslySetInnerHTML={{ __html: trunkSvg }}
          />
        )}
        <div style={auraStyle} />
        {maskEls}
        <div style={crownStyle}>
          <div style={{ width: '100%', height: '100%', animation: gemIris ? `tmx-iris ${lvl >= 6 ? 4 : 6}s linear infinite` : 'none' }}>
            <div
              style={{ width: '100%', height: '100%', transformOrigin: 'center', animation: 'tmx-gembreathe 4.6s ease-in-out infinite' }}
              dangerouslySetInnerHTML={{ __html: gemSvg }}
            />
          </div>
          <div
            style={{
              position: 'absolute',
              left: '34%',
              top: '30%',
              width: '14%',
              height: '14%',
              borderRadius: '50%',
              background: 'radial-gradient(closest-side,#fff,transparent)',
              filter: 'blur(1px)',
              zIndex: 2,
              pointerEvents: 'none',
              opacity: 0,
              animation: crownLit ? 'tmx-glint 4.5s ease-in-out infinite' : 'none',
            }}
          />
        </div>
        {sparkEls}
      </div>
    </div>
  );
}
