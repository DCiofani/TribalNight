// TEMP — swappabile quando arriva il design (Claude Design).
//
// DEMO / PLACEHOLDER SOSTITUIBILE (vincolo 5 + branding §2).
// Questo è un segnaposto: l'asset definitivo del totem (modello africano / albero
// della vita Eden, 2D o 3D) verrà fornito. Tieni questo componente ISOLATO: chi lo
// sostituisce deve solo rispettare la prop `level` (0–6, mappata su totem_level()).
// Nessun calcolo di business qui: `level` arriva già risolto dal chiamante.
//
// Mappa livelli (branding §5):
//   0     spento, glow tenue
//   1–2   prima aura viola
//   3     pulsazione a metà
//   4     aura piena
//   5     scintille d'ambra
//   6     "in fiamme" viola-oro, particellare
import React from 'react';

export default function Totem({ level }: { level: number }) {
  // clamp difensivo 0–6 (presentazione, non logica di dominio)
  const lvl = Math.max(0, Math.min(6, Math.round(level)));

  // intensità crescente 0→1
  const t = lvl / 6;

  // scala, glow e opacità crescono col livello
  const scale = 0.7 + t * 0.3; // 0.7 → 1.0
  const glow = 8 + lvl * 10; // raggio alone
  const auraOpacity = 0.15 + t * 0.65;

  // scintille d'ambra dal livello 5 in su (branding §5)
  const sparks = lvl >= 5 ? (lvl === 6 ? 8 : 4) : 0;

  // anelli tribali concentrici: più anelli accesi al salire del livello
  const rings = [0, 1, 2];

  return (
    <div
      role="img"
      aria-label={`Totem livello ${lvl} di 6`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        padding: '24px 0',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: 200,
          height: 200,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${scale})`,
          transition: 'transform 400ms cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* anelli tribali concentrici */}
        {rings.map((r) => {
          const size = 200 - r * 40;
          const active = lvl >= (r + 1) * 2 - 1;
          return (
            <span
              key={r}
              aria-hidden="true"
              style={{
                position: 'absolute',
                width: size,
                height: size,
                borderRadius: '50%',
                border: '1px solid var(--eden-lavender)',
                opacity: active ? 0.25 + t * 0.25 : 0.06,
                transition: 'opacity 400ms ease',
              }}
            />
          );
        })}

        {/* nucleo del totem: gradiente del logo */}
        <span
          aria-hidden="true"
          style={{
            width: 120,
            height: 120,
            borderRadius: '50%',
            background: 'var(--totem-grad)',
            opacity: 0.4 + t * 0.6,
            boxShadow: `0 0 ${glow}px ${glow / 2}px var(--eden-violet)`,
            transition: 'opacity 400ms ease, box-shadow 400ms ease',
          }}
        />

        {/* aura interna */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            width: 90,
            height: 90,
            borderRadius: '50%',
            background:
              'radial-gradient(circle, var(--eden-lavender) 0%, transparent 70%)',
            opacity: auraOpacity,
            transition: 'opacity 400ms ease',
          }}
        />

        {/* scintille d'ambra/oro (livelli alti) */}
        {Array.from({ length: sparks }).map((_, i) => {
          const angle = (360 / Math.max(1, sparks)) * i;
          const radius = 78;
          const x = Math.cos((angle * Math.PI) / 180) * radius;
          const y = Math.sin((angle * Math.PI) / 180) * radius;
          return (
            <span
              key={i}
              aria-hidden="true"
              style={{
                position: 'absolute',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: lvl >= 6 ? 'var(--gold)' : 'var(--ember)',
                transform: `translate(${x}px, ${y}px)`,
                boxShadow: `0 0 6px 2px ${
                  lvl >= 6 ? 'var(--gold)' : 'var(--ember)'
                }`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
