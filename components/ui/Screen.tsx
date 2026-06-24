// TEMP — swappabile quando arriva il design (Claude Design).
// Wrapper di schermata: presentazione isolata dalla logica.
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
      <p className="tag">{kicker}</p>
      <h1>{title}</h1>
      {children}
    </main>
  );
}
