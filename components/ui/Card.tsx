// TEMP — swappabile quando arriva il design (Claude Design).
// Superficie elevata: usa il token .card di globals.css.
import React from 'react';

export default function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="card" style={style}>
      {children}
    </div>
  );
}
