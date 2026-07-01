// Wrapper di schermata — presentazione isolata dalla logica.
// Kicker rituale (Cinzel) + titolo d'impatto (Anton, via globals.css).
import React from 'react';

export default function Screen({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main>
      <header style={{ marginBottom: 18 }}>
        <p
          className="tag"
          style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 22,
              height: 2,
              background: 'var(--ember)',
              boxShadow: '0 0 8px var(--ember)',
            }}
          />
          {kicker}
        </p>
        <h1>{title}</h1>
      </header>
      {children}
    </main>
  );
}
