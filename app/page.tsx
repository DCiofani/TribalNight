// ENTRY CLIENTE (dominio.com/) — splash + smistamento.
// Mostra lo splash rituale (wordmark + Totem che si accende + tagline + loader)
// come stato di caricamento, poi SU MOUNT smista SEMPRE il cliente:
//   loadGuestId() → id presente  → /guest       (ospite già registrato)
//   loadGuestId() → null         → /onboarding  (nuovo ospite)
// localStorage si legge SOLO lato client (in useEffect): il primo render SSR e il
// primo render client sono identici (splash puro) → nessun mismatch d'idratazione.
// Un failsafe garantisce che il redirect avvenga comunque (nessun deadlock).
'use client';

import React, { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Totem from '@/components/Totem';
import { loadGuestId } from '@/lib/guest-session';
import { APP_CONFIG } from '@/lib/config';

// Il wordmark è in due parole impilate (TOTEM / NIGHT) a prescindere dal brand:
// se il nome ha una sola parola resta su una riga, senza rompere il layout.
const WORDMARK = APP_CONFIG.name.trim().split(/\s+/);

// Rete di sicurezza: anche se qualcosa slitta, il cliente NON resta mai fermo sullo
// splash. Breve pausa leggibile (lo splash si vede), poi smistamento comunque.
const REDIRECT_MS = 900;

export default function Home() {
  const router = useRouter();
  // Smista UNA SOLA volta (mount + failsafe non devono navigare due volte).
  const routedRef = useRef(false);

  useEffect(() => {
    const go = () => {
      if (routedRef.current) return;
      routedRef.current = true;
      // loadGuestId legge localStorage: qui siamo garantiti lato client.
      router.replace(loadGuestId() ? '/guest' : '/onboarding');
    };

    // Piccola attesa per far percepire lo splash; il failsafe copre ogni caso limite.
    const t = setTimeout(go, REDIRECT_MS);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <main
      aria-busy="true"
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 22,
        textAlign: 'center',
      }}
    >
      {/* Kicker rituale */}
      <p className="tag" style={{ margin: 0 }}>
        Aperitivo tribale
      </p>

      {/* Wordmark d'impatto */}
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(44px, 15vw, 72px)',
          lineHeight: 0.9,
          letterSpacing: '0.03em',
          textTransform: 'uppercase',
          margin: 0,
          color: 'var(--ink-0)',
        }}
      >
        {WORDMARK.map((w, i) => (
          <span key={i} style={{ display: 'block' }}>
            {w}
          </span>
        ))}
      </h1>

      {/* Totem che si accende (stato di caricamento) */}
      <div style={{ display: 'grid', placeItems: 'center' }}>
        <Totem level={4} size={190} />
      </div>

      {/* Tagline */}
      <p
        style={{
          fontFamily: 'var(--font-ritual)',
          fontWeight: 600,
          fontSize: 14,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--ink-300)',
          margin: 0,
        }}
      >
        Accendi il totem
      </p>

      {/* Loader */}
      <div
        role="status"
        aria-label="Caricamento"
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          border: '3px solid var(--night-700)',
          borderTopColor: 'var(--gold)',
          animation: 'tn-splash-spin 0.9s linear infinite',
        }}
      />

      {/* Keyframe locale del loader (non ripete alcuna classe globale). */}
      <style>{`
        @keyframes tn-splash-spin {
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          [aria-label='Caricamento'] { animation: none !important; }
        }
      `}</style>
    </main>
  );
}
