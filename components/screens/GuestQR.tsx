// G4 — Mostra alla cassa (QR + PIN). Porting fedele dal mockup Claude.
// Il QR ora è REALE e scansionabile: codifica in byte-mode (ECC livello L) il
// `guestId` (l'identificativo dell'ospite); in mancanza usa il `pin` come payload.
// Encoder QR self-contained (nessuna dipendenza esterna): byte-mode, versioni
// 1..10, sufficienti per un UUID. Nome + PIN restano leggibili come fallback umano.
'use client';

import React from 'react';

/* ────────────────────────────────────────────────────────────────────────────
   MINI-ENCODER QR — byte mode, ECC livello L, versioni 1..10.
   Copre ampiamente un UUID (36 char) o un PIN. Nessuna libreria esterna.
   ──────────────────────────────────────────────────────────────────────────── */

// GF(256) — tabelle esponenziali/logaritmiche (polinomio 0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// Polinomio generatore per `degree` byte di correzione
function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let d = 0; d < degree; d++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= gfMul(poly[i], GF_EXP[d]);
    }
    poly = next;
  }
  return poly;
}

// Byte di correzione errori (Reed–Solomon) per un blocco dati
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j], factor);
    }
  }
  return res;
}

// Parametri per versione (livello L): [totalCodewords, ecCodewordsPerBlock, numBlocks]
// Fino alla versione 10 — payload byte-mode fino a ~271 byte.
const VERSION_L: Record<number, [number, number, number]> = {
  1: [26, 7, 1],
  2: [44, 10, 1],
  3: [70, 15, 1],
  4: [100, 20, 1],
  5: [134, 26, 1],
  6: [172, 18, 2],
  7: [196, 20, 2],
  8: [242, 24, 2],
  9: [292, 30, 2],
  10: [346, 18, 4],
};

// Capacità dati byte-mode (livello L) per versione — usata per scegliere la versione
// = dataCodewords - overhead(mode 4 bit + count 8/16 bit + terminator, arrotondato a byte)
function byteCapacity(version: number): number {
  const [total, ecPerBlock, blocks] = VERSION_L[version];
  const dataCodewords = total - ecPerBlock * blocks;
  const countBits = version >= 10 ? 16 : 8;
  // 4 bit mode + countBits header; il resto sono i byte del payload
  return Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
}

function pickVersion(len: number): number {
  for (let v = 1; v <= 10; v++) if (byteCapacity(v) >= len) return v;
  return 10; // se troppo lungo, tronca sulla 10 (non dovrebbe accadere per UUID/PIN)
}

// Coordinate dei pattern di allineamento per versione (2..10)
const ALIGN_POS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// Bit stream helper
class BitBuffer {
  bits: number[] = [];
  put(val: number, len: number) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

// Costruisce i codeword finali (dati + EC, interleaved) per un payload string
function buildCodewords(text: string, version: number): number[] {
  const [total, ecPerBlock, numBlocks] = VERSION_L[version];
  const dataCodewords = total - ecPerBlock * numBlocks;

  // Payload in UTF-8
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }

  const bb = new BitBuffer();
  bb.put(0b0100, 4); // mode: byte
  bb.put(bytes.length, version >= 10 ? 16 : 8); // character count
  for (const b of bytes) bb.put(b, 8);

  // Terminator (max 4 bit) senza superare la capacità
  const capacityBits = dataCodewords * 8;
  const term = Math.min(4, capacityBits - bb.length);
  bb.put(0, term);
  // Pad a multiplo di 8
  while (bb.length % 8 !== 0) bb.bits.push(0);

  // Codeword dati
  const data: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j];
    data.push(v);
  }
  // Pad bytes alternati 0xEC / 0x11
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (data.length < dataCodewords) data.push(padBytes[pi++ % 2]);

  // Suddivisione in blocchi (con eventuale gruppo "corto" e "lungo")
  const shortLen = Math.floor(dataCodewords / numBlocks);
  const longCount = dataCodewords % numBlocks; // ultimi `longCount` blocchi hanno +1
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = shortLen + (b >= numBlocks - longCount ? 1 : 0);
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  // Interleave dati
  const result: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) result.push(blk[i]);
  }
  // Interleave EC
  for (let i = 0; i < ecPerBlock; i++) {
    for (const blk of ecBlocks) result.push(blk[i]);
  }
  return result;
}

// Matrice QR: colloca funzioni + dati, sceglie la maschera ottimale
function buildMatrix(text: string): { size: number; modules: boolean[][] } {
  const version = pickVersion(
    (() => {
      // lunghezza in byte UTF-8
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      }
      return n;
    })()
  );
  const size = version * 4 + 17;

  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array(size).fill(null)
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array(size).fill(false)
  );

  const setFunc = (r: number, c: number, v: boolean) => {
    modules[r][c] = v;
    reserved[r][c] = true;
  };

  // Finder pattern + separatori
  const placeFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inRing =
          dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inRing || inCenter);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing pattern
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Pattern di allineamento
  const positions = ALIGN_POS[version] || [];
  for (const pr of positions) {
    for (const pc of positions) {
      // salta quelli sovrapposti ai finder
      if (
        (pr <= 8 && pc <= 8) ||
        (pr <= 8 && pc >= size - 9) ||
        (pr >= size - 9 && pc <= 8)
      )
        continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(pr + dr, pc + dc, ring !== 1);
        }
      }
    }
  }

  // Dark module
  setFunc(size - 8, 8, true);

  // Riserva aree format info (senza impostare bit)
  const reserveFormat = () => {
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        reserved[8][i] = true;
        reserved[i][8] = true;
      }
    }
    for (let i = 0; i < 8; i++) {
      reserved[8][size - 1 - i] = true;
      reserved[size - 1 - i][8] = true;
    }
    reserved[8][7] = true;
  };
  reserveFormat();

  // Codeword → bit stream
  const codewords = buildCodewords(text, version);
  const dataBits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1);

  // Posiziona i dati con lo zig-zag standard
  let bitIdx = 0;
  let dirUp = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // salta la timing column
    for (let i = 0; i < size; i++) {
      const row = dirUp ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (reserved[row][c]) continue;
        let bit = bitIdx < dataBits.length ? dataBits[bitIdx] === 1 : false;
        bitIdx++;
        modules[row][c] = bit;
      }
    }
    dirUp = !dirUp;
  }

  // ── Selezione maschera (valuta le 8, sceglie penalità minima) ──
  const maskFns: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  const applyMask = (mat: boolean[][], maskIdx: number) => {
    const fn = maskFns[maskIdx];
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!reserved[r][c] && fn(r, c)) mat[r][c] = !mat[r][c];
  };

  // Format info (ECC level L = 01) con maschera BCH
  const placeFormat = (mat: boolean[][], maskIdx: number) => {
    const data = (0b01 << 3) | maskIdx; // L + mask
    let bch = data << 10;
    const g = 0b10100110111;
    for (let i = 14; i >= 10; i--) if ((bch >> i) & 1) bch ^= g << (i - 10);
    const fmt = ((data << 10) | bch) ^ 0b101010000010010;
    const bitsArr: number[] = [];
    for (let i = 14; i >= 0; i--) bitsArr.push((fmt >> i) & 1);
    // Posizionamento standard delle 15 bit
    for (let i = 0; i <= 5; i++) mat[8][i] = bitsArr[i] === 1;
    mat[8][7] = bitsArr[6] === 1;
    mat[8][8] = bitsArr[7] === 1;
    mat[7][8] = bitsArr[8] === 1;
    for (let i = 9; i <= 14; i++) mat[14 - i][8] = bitsArr[i] === 1;
    for (let i = 0; i <= 7; i++) mat[size - 1 - i][8] = bitsArr[i] === 1;
    for (let i = 8; i <= 14; i++) mat[8][size - 15 + i] = bitsArr[i] === 1;
  };

  // Penalità (regole standard QR) per scegliere la maschera
  const penalty = (mat: boolean[][]): number => {
    let p = 0;
    // Regola 1: run di 5+ moduli uguali (righe e colonne)
    for (let r = 0; r < size; r++) {
      let runC = 1;
      for (let c = 1; c < size; c++) {
        if (mat[r][c] === mat[r][c - 1]) {
          runC++;
          if (runC === 5) p += 3;
          else if (runC > 5) p += 1;
        } else runC = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let runR = 1;
      for (let r = 1; r < size; r++) {
        if (mat[r][c] === mat[r - 1][c]) {
          runR++;
          if (runR === 5) p += 3;
          else if (runR > 5) p += 1;
        } else runR = 1;
      }
    }
    // Regola 2: blocchi 2x2 dello stesso colore
    for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++) {
        const v = mat[r][c];
        if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) p += 3;
      }
    // Regola 3: pattern finder-like 1:1:3:1:1 con margine chiaro
    const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    const matchPat = (arr: boolean[], pat: boolean[]) => {
      for (let i = 0; i < pat.length; i++) if (arr[i] !== pat[i]) return false;
      return true;
    };
    for (let r = 0; r < size; r++)
      for (let c = 0; c <= size - 11; c++) {
        const seg = mat[r].slice(c, c + 11);
        if (matchPat(seg, pat1) || matchPat(seg, pat2)) p += 40;
      }
    for (let c = 0; c < size; c++)
      for (let r = 0; r <= size - 11; r++) {
        const seg: boolean[] = [];
        for (let k = 0; k < 11; k++) seg.push(mat[r + k][c]);
        if (matchPat(seg, pat1) || matchPat(seg, pat2)) p += 40;
      }
    // Regola 4: bilanciamento dark/light
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (mat[r][c]) dark++;
    const ratio = (dark * 100) / (size * size);
    p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return p;
  };

  const baseBool: boolean[][] = modules.map((row) => row.map((v) => v === true));

  let best = -1;
  let bestPenalty = Infinity;
  let bestMat: boolean[][] = baseBool;
  for (let mIdx = 0; mIdx < 8; mIdx++) {
    const cand = baseBool.map((r) => r.slice());
    applyMask(cand, mIdx);
    placeFormat(cand, mIdx);
    const pen = penalty(cand);
    if (pen < bestPenalty) {
      bestPenalty = pen;
      best = mIdx;
      bestMat = cand;
    }
  }
  void best;

  return { size, modules: bestMat };
}

// Rende la matrice QR come SVG (moduli scuri = `fg`, sfondo trasparente)
function qrSvg(pxSize: number, fg: string, payload: string): string {
  let matrix: { size: number; modules: boolean[][] };
  try {
    matrix = buildMatrix(payload || ' ');
  } catch {
    // In caso estremo non blocchiamo la UI: QR minimo su spazio
    matrix = buildMatrix(' ');
  }
  const { size, modules } = matrix;
  const quiet = 4; // margine chiaro obbligatorio (moduli)
  const total = size + quiet * 2;
  const cell = pxSize / total;

  let rects = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        const x = (c + quiet) * cell;
        const y = (r + quiet) * cell;
        // rettangoli leggermente sovrapposti per evitare hairline gaps
        rects += `<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${(cell + 0.6).toFixed(
          3
        )}" height="${(cell + 0.6).toFixed(3)}" fill="${fg}"/>`;
      }
    }
  }
  return `<svg viewBox="0 0 ${pxSize} ${pxSize}" width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="QR ospite">${rects}</svg>`;
}

/* ──────────────────────────────────────────────────────────────────────────── */

type Props = { name?: string; pin?: string; guestId?: string; onBack?: () => void };

export default function GuestQR({ name = '', pin = '----', guestId, onBack }: Props) {
  // Payload del QR: preferisci l'identificativo ospite; fallback sul PIN.
  const payload = (guestId && guestId.trim()) || (pin && pin.trim()) || '';

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
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, letterSpacing: '.04em' }}>{name || '—'}</div>
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
          dangerouslySetInnerHTML={{ __html: qrSvg(220, '#231405', payload) }}
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
