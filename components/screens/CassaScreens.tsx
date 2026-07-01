// Cassa (POS) — C1–C5. Porting fedele dal mockup Claude. Presentazionali:
// i dati e gli handler arrivano come prop; la logica resta nelle pagine/route.
'use client';

import React from 'react';

const wrap: React.CSSProperties = {
  position: 'relative',
  minHeight: '100dvh',
  color: '#fff',
  fontFamily: 'var(--font-ui)',
  background: '#160C06',
};
const padTop = 'max(54px, calc(env(safe-area-inset-top) + 18px))';
const backBtn = (onBack?: () => void) => (
  <button
    onClick={onBack}
    style={{ width: 38, height: 38, borderRadius: 11, border: '1px solid #43291A', background: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#D8C3A6', cursor: 'pointer', fontSize: 18 }}
  >
    ‹
  </button>
);

// ── C1 — Home cassa (staff) ────────────────────────────────────────────────
export function CassaHome({
  staffName = 'STAFF',
  stato = 'APERTA',
  ricaricheOggi = '—',
  incasso = '—',
  onRicarica,
  onConsuma,
  onLogout,
}: {
  staffName?: string;
  stato?: string;
  ricaricheOggi?: number | string;
  incasso?: string;
  onRicarica?: () => void;
  onConsuma?: () => void;
  onLogout?: () => void;
}) {
  return (
    <div style={{ ...wrap, padding: `${padTop} 22px 0` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.18em', fontSize: 11, color: '#A58A66' }}>CASSA</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 24 }}>{staffName}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ background: 'rgba(43,163,90,.12)', border: '1px solid rgba(43,163,90,.5)', color: '#2BA35A', borderRadius: 99, padding: '6px 14px', fontWeight: 700, fontSize: 13, letterSpacing: '.1em' }}>
            {stato}
          </div>
          {onLogout ? (
            <button onClick={onLogout} style={{ background: 'none', border: '1px solid #43291A', color: '#A58A66', borderRadius: 10, padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>Esci</button>
          ) : null}
        </div>
      </div>
      <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <button onClick={onRicarica} style={{ height: 160, borderRadius: 16, background: '#2A1A11', border: '1px solid #4A2D1C', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, boxShadow: 'inset 0 0 0 1px rgba(58,91,190,.18)', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
          <span style={{ width: 48, height: 48, borderRadius: 14, background: 'rgba(58,91,190,.16)', border: '1px solid #3A5BBE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, color: '#D89A3E' }}>↑</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, letterSpacing: '.04em' }}>RICARICA</span>
        </button>
        <button onClick={onConsuma} style={{ height: 160, borderRadius: 16, background: '#2A1A11', border: '1px solid #4A2D1C', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, boxShadow: 'inset 0 0 0 1px rgba(238,99,33,.18)', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
          <span style={{ width: 48, height: 48, borderRadius: 14, background: 'rgba(238,99,33,.16)', border: '1px solid #EE6321', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>🥃</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, letterSpacing: '.04em' }}>CONSUMA</span>
        </button>
      </div>
      <div style={{ position: 'absolute', left: 22, right: 22, bottom: 48, textAlign: 'center', color: '#A58A66', fontSize: 13 }}>
        Ricariche oggi: <b style={{ color: '#fff' }}>{ricaricheOggi}</b> · Incasso registrato: <b style={{ color: '#fff' }}>{incasso}</b>
      </div>
    </div>
  );
}

// ── C2 — Identifica ospite (scan / PIN) ────────────────────────────────────
export type CassaGuestResult = { nome: string; sub: string };
export function CassaScan({
  title = 'RICARICA — CHI?',
  results = [],
  pinField,
  onBack,
  onPick,
}: {
  title?: string;
  results?: CassaGuestResult[];
  pinField?: React.ReactNode;
  onBack?: () => void;
  onPick?: (i: number) => void;
}) {
  const corner = (s: React.CSSProperties) => <div style={{ position: 'absolute', width: 34, height: 34, ...s }} />;
  return (
    <div style={wrap}>
      <div style={{ padding: `${padTop} 22px 0`, display: 'flex', alignItems: 'center', gap: 14 }}>
        {backBtn(onBack)}
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>{title}</div>
      </div>
      <div style={{ margin: '18px 22px 0', height: 300, borderRadius: 18, background: '#1B0F07', border: '1px solid #43291A', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {corner({ top: 24, left: 24, borderTop: '3px solid #3A5BBE', borderLeft: '3px solid #3A5BBE', borderRadius: '6px 0 0 0' })}
        {corner({ top: 24, right: 24, borderTop: '3px solid #3A5BBE', borderRight: '3px solid #3A5BBE', borderRadius: '0 6px 0 0' })}
        {corner({ bottom: 24, left: 24, borderBottom: '3px solid #3A5BBE', borderLeft: '3px solid #3A5BBE', borderRadius: '0 0 0 6px' })}
        {corner({ bottom: 24, right: 24, borderBottom: '3px solid #3A5BBE', borderRight: '3px solid #3A5BBE', borderRadius: '0 0 6px 0' })}
        <div style={{ color: '#A58A66', fontSize: 14 }}>Inquadra il QR dell&apos;ospite</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 22px 0', color: '#7E6A52', fontSize: 12 }}>
        <div style={{ flex: 1, height: 1, background: '#43291A' }} />
        OPPURE
        <div style={{ flex: 1, height: 1, background: '#43291A' }} />
      </div>
      <div style={{ margin: '14px 22px 0' }}>
        {pinField ?? (
          <div style={{ height: 54, borderRadius: 12, background: '#2A1A11', border: '1px solid #4A2D1C', display: 'flex', alignItems: 'center', padding: '0 16px', color: '#A58A66', fontSize: 15 }}>
            PIN o nome
          </div>
        )}
      </div>
      <div style={{ padding: '14px 22px 40px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {results.map((r, i) => (
          <button key={i} onClick={() => onPick?.(i)} style={{ background: '#2A1A11', border: '1px solid #43291A', borderRadius: 12, padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#fff', cursor: 'pointer', fontFamily: 'var(--font-ui)', textAlign: 'left' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{r.nome}</div>
              <div style={{ fontSize: 12, color: '#A58A66' }}>{r.sub}</div>
            </div>
            <span style={{ color: '#7E6A52' }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── C3 — Ricarica (importo) ────────────────────────────────────────────────
export function CassaRicarica({
  guestName = '',
  guestSub = '',
  tipo = 'NORMALE',
  prezzoN = '€5',
  prezzoP = '€8',
  qty = 1,
  totale = '€ 0,00',
  onTipo,
  onDec,
  onInc,
  onConfirm,
  onBack,
}: {
  guestName?: string;
  guestSub?: string;
  tipo?: 'NORMALE' | 'PREMIUM';
  prezzoN?: string;
  prezzoP?: string;
  qty?: number;
  totale?: string;
  onTipo?: (t: 'NORMALE' | 'PREMIUM') => void;
  onDec?: () => void;
  onInc?: () => void;
  onConfirm?: () => void;
  onBack?: () => void;
}) {
  const tipoCard = (key: 'NORMALE' | 'PREMIUM', prezzo: string) => {
    const on = tipo === key;
    return (
      <button onClick={() => onTipo?.(key)} style={{ flex: 1, height: 76, borderRadius: 14, background: on ? 'rgba(58,91,190,.16)' : '#2A1A11', border: on ? '2px solid #3A5BBE' : '1px solid #4A2D1C', color: on ? '#fff' : '#D8C3A6', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>{key}</span>
        <span style={{ color: on ? '#D89A3E' : '#D8C3A6', fontSize: 14 }}>{prezzo}</span>
      </button>
    );
  };
  return (
    <div style={{ ...wrap, padding: `${padTop} 22px 0` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {backBtn(onBack)}
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 24 }}>RICARICA</div>
      </div>
      <div style={{ marginTop: 16, background: '#2A1A11', border: '1px solid #43291A', borderRadius: 12, padding: 14, fontWeight: 600 }}>
        {guestName} <span style={{ color: '#A58A66', fontWeight: 400 }}>{guestSub ? `· ${guestSub}` : ''}</span>
      </div>
      <div style={{ marginTop: 18, display: 'flex', gap: 12 }}>
        {tipoCard('NORMALE', prezzoN)}
        {tipoCard('PREMIUM', prezzoP)}
      </div>
      <div style={{ marginTop: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
        <button onClick={onDec} style={{ width: 64, height: 64, borderRadius: 16, border: '1px solid #4A2D1C', background: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, color: '#D8C3A6', cursor: 'pointer' }}>−</button>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 64, minWidth: 80, textAlign: 'center' }}>{qty}</div>
        <button onClick={onInc} style={{ width: 64, height: 64, borderRadius: 16, background: '#3A5BBE', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, cursor: 'pointer' }}>+</button>
      </div>
      <div style={{ marginTop: 28, background: 'rgba(242,180,60,.08)', border: '1px solid rgba(242,180,60,.3)', borderRadius: 12, padding: 16, textAlign: 'center' }}>
        <div style={{ color: '#A58A66', fontSize: 12, letterSpacing: '.1em' }}>DA INCASSARE</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, color: '#F2B43C' }}>{totale}</div>
      </div>
      <div style={{ textAlign: 'center', color: '#A58A66', fontSize: 12, marginTop: 14 }}>Incassa con POS/contanti, poi conferma</div>
      <button onClick={onConfirm} style={{ position: 'absolute', left: 22, right: 22, bottom: 48, height: 58, borderRadius: 14, background: 'linear-gradient(90deg,#EE6321,#F2B43C)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16, color: '#1A0F08', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
        Conferma ricarica
      </button>
    </div>
  );
}

// ── C4 — Consuma (listino) ─────────────────────────────────────────────────
export type DrinkTile = { name: string; tag: string; tagColor: string; border: string; opacity: number; lock: string };
export function CassaConsuma({
  guestName = '',
  normali = '—',
  premium = '—',
  tiles = [],
  onBack,
  onPick,
}: {
  guestName?: string;
  normali?: number | string;
  premium?: number | string;
  tiles?: DrinkTile[];
  onBack?: () => void;
  onPick?: (i: number) => void;
}) {
  return (
    <div style={{ ...wrap, padding: `${padTop} 22px 0` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {backBtn(onBack)}
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>CONSUMA — {guestName}</div>
      </div>
      <div style={{ marginTop: 14, display: 'flex', gap: 12 }}>
        <div style={{ flex: 1, background: '#2A1A11', border: '1px solid #43291A', borderRadius: 12, padding: 12, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>{normali}</div>
          <div style={{ fontSize: 10, letterSpacing: '.12em', color: '#A58A66' }}>NORMALI</div>
        </div>
        <div style={{ flex: 1, background: '#2A1A11', border: '1px solid #5E83CE66', borderRadius: 12, padding: 12, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: '#9BB6EC' }}>{premium}</div>
          <div style={{ fontSize: 10, letterSpacing: '.12em', color: '#D89A3E' }}>PREMIUM</div>
        </div>
      </div>
      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, paddingBottom: 40 }}>
        {tiles.map((d, i) => (
          <button key={i} onClick={() => onPick?.(i)} style={{ height: 108, borderRadius: 16, background: '#2A1A11', border: `1px solid ${d.border}`, padding: 14, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', opacity: d.opacity, position: 'relative', color: '#fff', cursor: 'pointer', fontFamily: 'var(--font-ui)', textAlign: 'left' }}>
            <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.2 }}>{d.name}</div>
            <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.08em', fontSize: 10, color: d.tagColor }}>{d.tag}</div>
            <div style={{ position: 'absolute', top: 12, right: 12, color: '#7E6A52', fontSize: 14 }}>{d.lock}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── C5 — Conferma (tap-to-pay, bottom sheet) ───────────────────────────────
export function CassaConferma({
  drinkName = '',
  guestName = '',
  tag = '',
  tagColor = '#9BB6EC',
  ticketLine = '',
  onConfirm,
  onCancel,
}: {
  drinkName?: string;
  guestName?: string;
  tag?: string;
  tagColor?: string;
  ticketLine?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  return (
    <div style={wrap}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(14,8,4,.82)' }} onClick={onCancel} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: '#2A1A11', borderTop: '1px solid #4A2D1C', borderRadius: '24px 24px 0 0', padding: '30px 26px max(40px, env(safe-area-inset-bottom))', textAlign: 'center' }}>
        <div style={{ width: 42, height: 4, borderRadius: 99, background: '#5A3826', margin: '0 auto 24px' }} />
        <div style={{ position: 'relative', width: 90, height: 90, margin: '0 auto 18px' }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid rgba(58,91,190,.3)' }} />
          <div style={{ position: 'absolute', inset: 14, borderRadius: '50%', border: '2px solid rgba(58,91,190,.5)' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, color: '#D89A3E' }}>))</div>
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 26 }}>CONFERMA CONSUMAZIONE</div>
        <div style={{ marginTop: 16, background: '#1B0F07', border: '1px solid #43291A', borderRadius: 14, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 600, fontSize: 17 }}>{drinkName}</div>
            <div style={{ fontSize: 12, color: '#A58A66' }}>Ospite · {guestName}</div>
          </div>
          <div style={{ fontFamily: 'var(--font-ritual)', fontSize: 11, letterSpacing: '.08em', color: tagColor, border: '1px solid #D89A3E', borderRadius: 8, padding: '6px 10px' }}>{tag}</div>
        </div>
        {ticketLine ? (
          <div style={{ marginTop: 14, fontFamily: 'var(--font-ritual)', letterSpacing: '.18em', fontSize: 14, color: '#F2B43C' }}>{ticketLine}</div>
        ) : null}
        <button onClick={onConfirm} style={{ marginTop: 22, width: '100%', height: 56, borderRadius: 14, background: '#3A5BBE', color: '#fff', border: 'none', fontWeight: 600, fontSize: 16, cursor: 'pointer', fontFamily: 'var(--font-ui)', boxShadow: '0 0 24px rgba(58,91,190,.4)' }}>Conferma</button>
        <button onClick={onCancel} style={{ marginTop: 12, width: '100%', height: 54, borderRadius: 14, border: '1px solid #4A2D1C', background: 'none', fontWeight: 600, fontSize: 15, color: '#D8C3A6', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>Annulla</button>
      </div>
    </div>
  );
}
