'use client';

// Pagina di anteprima/sviluppo per il TotemStack. Non parte dell'app finale.
// Controlli: livello 0–6, carica manuale 0–100%, modalità splash (loop).
import React from 'react';
import TotemStack from '@/components/TotemStack';

type Mode = 'level' | 'charge' | 'loading';

export default function TotemDemo() {
  const [mode, setMode] = React.useState<Mode>('level');
  const [level, setLevel] = React.useState(4);
  const [charge, setCharge] = React.useState(50);

  return (
    <main style={{ maxWidth: 520 }}>
      <p className="tag">Dev · anteprima TotemStack</p>
      <h1>Totem — carica</h1>

      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          minHeight: 420,
          background:
            'radial-gradient(circle at 50% 40%, #15112400, #0a0a12 70%)',
          borderRadius: 16,
          border: '1px solid var(--night-700)',
          margin: '12px 0',
          overflow: 'hidden',
        }}
      >
        {mode === 'level' && <TotemStack level={level} size={220} />}
        {mode === 'charge' && <TotemStack charge={charge / 100} size={220} />}
        {mode === 'loading' && <TotemStack loading size={220} />}
      </div>

      <div className="card" style={{ display: 'grid', gap: 16 }}>
        {/* modalità */}
        <div style={{ display: 'flex', gap: 8 }}>
          {(['level', 'charge', 'loading'] as Mode[]).map((m) => (
            <button
              key={m}
              className="btn"
              onClick={() => setMode(m)}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid var(--night-700)',
                background:
                  mode === m ? 'var(--eden-violet)' : 'var(--night-800)',
                color: 'var(--ink-0)',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {m === 'loading' ? 'splash' : m}
            </button>
          ))}
        </div>

        {mode === 'level' && (
          <div>
            <p className="tag" style={{ marginBottom: 8 }}>
              Livello {level} / 6
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              {[0, 1, 2, 3, 4, 5, 6].map((l) => (
                <button
                  key={l}
                  className="btn"
                  onClick={() => setLevel(l)}
                  style={{
                    flex: 1,
                    padding: '10px 0',
                    borderRadius: 10,
                    border: '1px solid var(--night-700)',
                    background:
                      level === l ? 'var(--eden-lavender)' : 'var(--night-800)',
                    color: level === l ? '#0a0a12' : 'var(--ink-0)',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === 'charge' && (
          <div>
            <p className="tag" style={{ marginBottom: 8 }}>
              Carica {charge}%
            </p>
            <input
              type="range"
              min={0}
              max={100}
              value={charge}
              onChange={(e) => setCharge(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--eden-violet)' }}
            />
          </div>
        )}

        {mode === 'loading' && (
          <p style={{ color: 'var(--ink-300)', margin: 0 }}>
            Carica automatica in loop (schermata splash S1).
          </p>
        )}
      </div>
    </main>
  );
}
