// Regia (desktop) — shell + sidebar + Dashboard (R1). Porting fedele dal mockup Claude.
// Le altre viste (R2 Fasi … R8 Ospiti) riusano <RegiaShell> con il proprio contenuto.
'use client';

import React from 'react';

export type RegiaTab =
  | 'dashboard' | 'fasi' | 'sessioni' | 'menu' | 'impostazioni' | 'estrazione' | 'ledger' | 'ospiti';

const NAV: [RegiaTab, string][] = [
  ['dashboard', 'Dashboard'],
  ['fasi', 'Controllo fasi'],
  ['sessioni', 'Sessioni tap'],
  ['menu', 'Gestione menù'],
  ['impostazioni', 'Impostazioni'],
  ['estrazione', 'Estrazione'],
  ['ledger', 'Ledger'],
  ['ospiti', 'Ospiti'],
];

export function RegiaSidebar({ active = 'dashboard', onNav }: { active?: RegiaTab; onNav?: (t: RegiaTab) => void }) {
  return (
    <div style={{ width: 240, alignSelf: 'stretch', background: '#170D06', borderRight: '1px solid #43291A', flexShrink: 0, display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-ui)' }}>
      <div style={{ padding: '26px 22px 22px' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, letterSpacing: '.06em', color: '#fff', lineHeight: 0.95 }}>
          TOTEM<br />NIGHT
        </div>
        <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.24em', fontSize: 10, color: '#D89A3E', marginTop: 8 }}>REGIA</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 14px' }}>
        {NAV.map(([id, label]) => {
          const on = id === active;
          return (
            <button
              key={id}
              onClick={() => onNav?.(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '11px 14px',
                borderRadius: 10,
                background: on ? 'rgba(58,91,190,.16)' : 'transparent',
                color: on ? '#fff' : '#A58A66',
                fontSize: 14.5,
                fontWeight: on ? 600 : 400,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-ui)',
                textAlign: 'left',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 3, background: on ? '#D89A3E' : '#4A2D1C' }} />
              {label}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 'auto', padding: '20px 22px', borderTop: '1px solid #43291A', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: '#3A2414', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#E7C98C' }}>R</div>
        <div style={{ fontSize: 13, color: '#D8C3A6' }}>Regia · Admin</div>
      </div>
    </div>
  );
}

export function RegiaShell({
  active = 'dashboard',
  title,
  stato = 'APERTA',
  time = '',
  onNav,
  headerRight,
  children,
}: {
  active?: RegiaTab;
  title: string;
  stato?: string;
  time?: string;
  onNav?: (t: RegiaTab) => void;
  headerRight?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', minHeight: '100dvh', background: '#190F08', color: '#fff', fontFamily: 'var(--font-ui)' }}>
      <RegiaSidebar active={active} onNav={onNav} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 72, borderBottom: '1px solid #43291A', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px', flexShrink: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, letterSpacing: '.04em' }}>{title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {headerRight ?? (
              <>
                <div style={{ background: 'rgba(43,163,90,.12)', border: '1px solid rgba(43,163,90,.5)', color: '#2BA35A', borderRadius: 99, padding: '6px 14px', fontWeight: 700, fontSize: 13 }}>{stato}</div>
                {time ? <div style={{ color: '#A58A66', fontSize: 14 }}>{time}</div> : null}
              </>
            )}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      </div>
    </div>
  );
}

export type Kpi = { label: string; value: string | number; color: string };
export type RegiaTx = { icon: string; iconBg: string; label: string; delta: string; deltaColor: string };
// Un punto della serie "Consumi per fascia oraria": etichetta ora ('HH:00') + numero consumi.
// I valori arrivano AGGREGATI dal server (count per fascia): il componente NON somma nulla,
// costruisce solo il path SVG scalando i punti reali sul massimo della serie.
export type ConsumiPoint = { ora: string; consumi: number };

// Geometria fissa dell'area-chart (viewBox). L'area è disegnata DENTRO questi margini così
// il tratto non viene tagliato ai bordi; l'asse Y è scalato sul max della serie ricevuta.
const CHART_W = 640;
const CHART_H = 240;
const CHART_PAD_T = 20; // spazio in alto (il picco non tocca il bordo)
const CHART_PAD_B = 20; // spazio in basso (base dell'area)

// buildAreaPaths(serie) -> { line, area } o null se la serie è vuota. Costruisce i due path
// SVG (tratto + riempimento) DAI PUNTI REALI: x distribuito uniformemente sulla larghezza,
// y scalato sul massimo dei consumi (max=0 → tutto a fondo grafico). Nessun dato inventato.
function buildAreaPaths(serie: ConsumiPoint[]): { line: string; area: string } | null {
  if (serie.length === 0) return null;
  const usableH = CHART_H - CHART_PAD_T - CHART_PAD_B;
  const maxY = Math.max(1, ...serie.map((p) => p.consumi)); // >=1: evita divisione per 0
  // Con un solo punto non esiste una "pendenza": lo centriamo in orizzontale.
  const stepX = serie.length > 1 ? CHART_W / (serie.length - 1) : 0;
  const pts = serie.map((p, i) => {
    const x = serie.length > 1 ? i * stepX : CHART_W / 2;
    const y = CHART_H - CHART_PAD_B - (p.consumi / maxY) * usableH;
    return { x, y };
  });
  const line = pts
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
    .join(' ');
  // L'area chiude il tratto verso la base del grafico (fill sotto la linea).
  const first = pts[0];
  const last = pts[pts.length - 1];
  const area = `${line} L ${last.x.toFixed(1)} ${CHART_H} L ${first.x.toFixed(1)} ${CHART_H} Z`;
  return { line, area };
}

export function RegiaDashboard({
  kpis = [],
  tx = [],
  consumiTimeline = [],
  stato = 'APERTA',
  time = '',
  onNav,
}: {
  kpis?: Kpi[];
  tx?: RegiaTx[];
  consumiTimeline?: ConsumiPoint[];
  stato?: string;
  time?: string;
  onNav?: (t: RegiaTab) => void;
}) {
  // Path costruiti DAI DATI REALI (o null → empty-state). Mai un path SVG hardcoded.
  const paths = buildAreaPaths(consumiTimeline);
  return (
    <RegiaShell active="dashboard" title="DASHBOARD" stato={stato} time={time} onNav={onNav}>
      <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 18 }}>
          {kpis.map((k, i) => (
            <div key={i} style={{ background: '#2A1A11', border: '1px solid #43291A', borderRadius: 16, padding: 20 }}>
              <div style={{ fontFamily: 'var(--font-ritual)', letterSpacing: '.16em', fontSize: 11, color: '#A58A66' }}>{k.label}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 40, color: k.color, marginTop: 8, lineHeight: 1 }}>{k.value}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 18 }}>
          <div style={{ background: '#2A1A11', border: '1px solid #43291A', borderRadius: 16, padding: 22 }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Consumi per fascia oraria</div>
            {paths ? (
              <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} style={{ width: '100%', height: CHART_H, marginTop: 8 }}>
                <defs>
                  <linearGradient id="regia-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3A5BBE" stopOpacity=".5" />
                    <stop offset="100%" stopColor="#3A5BBE" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={paths.area} fill="url(#regia-area)" />
                <path d={paths.line} fill="none" stroke="#D89A3E" strokeWidth="3" />
              </svg>
            ) : (
              <div
                style={{
                  height: CHART_H,
                  marginTop: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#A58A66',
                  fontSize: 14,
                }}
              >
                Dati non disponibili
              </div>
            )}
          </div>
          <div style={{ background: '#2A1A11', border: '1px solid #43291A', borderRadius: 16, padding: 22 }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 14 }}>Ultime transazioni</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {tx.map((t, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: t.iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>{t.icon}</div>
                  <div style={{ flex: 1, fontSize: 13.5 }}>{t.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.deltaColor }}>{t.delta}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </RegiaShell>
  );
}
