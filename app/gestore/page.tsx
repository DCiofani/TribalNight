// LANDING GESTORE (dominio.com/gestore) — ingresso STAFF, path-based.
// Sobria e on-brand (palette calda, font display/ritual). NESSUN login qui: il
// login vive nelle rispettive pagine (/cassa, /regia). Due tile grandi:
//   CASSA  → /cassa  (banco: ricarica & consumo)
//   REGIA  → /regia  (controllo serata: dashboard, fasi, estrazione)
'use client';

import React from 'react';
import Link from 'next/link';

// Colori presi dai token globali (globals.css). Dove serve un hex (gradienti tile)
// riuso ESATTAMENTE quelli già usati da components/ui/Button.tsx (primary/indigo),
// così le tile parlano lo stesso linguaggio visivo del resto dell'app.
const tileBase: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '22px 20px',
  borderRadius: 16,
  minHeight: 128,
  justifyContent: 'flex-end',
  textDecoration: 'none',
  transition: 'transform 120ms cubic-bezier(0.16,1,0.3,1), filter 120ms',
};

export default function GestorePage() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 26,
      }}
    >
      <header style={{ display: 'grid', gap: 8 }}>
        <p className="tag" style={{ margin: 0 }}>
          Pannello staff
        </p>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(40px, 13vw, 60px)',
            lineHeight: 0.92,
            letterSpacing: '0.03em',
            textTransform: 'uppercase',
            margin: 0,
            color: 'var(--ink-0)',
          }}
        >
          Gestore
        </h1>
        <p
          style={{
            fontFamily: 'var(--font-ritual)',
            fontWeight: 600,
            fontSize: 14,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--ink-300)',
            margin: 0,
          }}
        >
          Scegli la postazione
        </p>
      </header>

      <nav style={{ display: 'grid', gap: 14 }}>
        {/* CASSA — banco (ember/terracotta, come Button primary) */}
        <Link
          href="/cassa"
          className="btn"
          style={{
            ...tileBase,
            background: 'linear-gradient(180deg, #f0712f, #d6471d)',
            border: '1px solid rgba(255,180,110,0.5)',
            boxShadow:
              '0 6px 22px -8px rgba(224,85,42,0.7), inset 0 1px 0 rgba(255,220,180,0.35)',
            color: '#fff',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 30,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              lineHeight: 1,
            }}
          >
            Cassa
          </span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 14, opacity: 0.92 }}>
            Banco — ricarica &amp; consumo
          </span>
        </Link>

        {/* REGIA — controllo serata (indigo "azioni serie", come Button indigo) */}
        <Link
          href="/regia"
          className="btn"
          style={{
            ...tileBase,
            background: 'linear-gradient(180deg, #4a6ad0, #324fa8)',
            border: '1px solid rgba(150,170,235,0.5)',
            boxShadow: '0 6px 22px -8px rgba(58,91,190,0.6)',
            color: '#fff',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 30,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              lineHeight: 1,
            }}
          >
            Regia
          </span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 14, opacity: 0.92 }}>
            Controllo serata — fasi &amp; estrazione
          </span>
        </Link>
      </nav>

      {/* Nota discreta */}
      <p
        style={{
          fontFamily: 'var(--font-ritual)',
          fontSize: 12,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--ink-500)',
          margin: 0,
          textAlign: 'center',
        }}
      >
        Accesso riservato allo staff
      </p>
    </main>
  );
}
