// TEMP — swappabile quando arriva il design (Claude Design).
//
// Schermata REGIA (spec §10): pannello dell'organizzatore.
// - indicatore di fase (SETUP→APERTA→LAST_CALL→ESTRAZIONE→CHIUSA)
// - dashboard 3 <Stat> (Presenze, Gettoni venduti, Ticket totali)
// - controlli (Lancia sessione 30s, Estrai)
//
// PRESENTAZIONE separata dalla logica. Il front-end NON calcola nulla:
// fase e statistiche sono placeholder statici. I dati veri arriveranno da
// RPC SECURITY DEFINER + Supabase Realtime in M2/M3.
//
//   TODO(RPC):       set_phase(...)      → avanza/imposta fase sessione
//   TODO(RPC):       start_session(30)   → countdown 30s lato server
//   TODO(RPC):       run_draw()          → estrazione vincitore
//   TODO(realtime):  channel "admin:stats" → Presenze / Gettoni / Ticket live
//   TODO(realtime):  channel "admin:phase" → fase corrente live
'use client';

import React from 'react';
import { Screen, Card, Button, Stat } from '@/components/ui';
import Totem from '@/components/Totem';

// Fasi del flusso serata (spec §10). Solo presentazione: l'ordine/labels
// sono per l'indicatore; il valore reale arriverà da realtime "admin:phase".
const PHASES = ['SETUP', 'APERTA', 'LAST_CALL', 'ESTRAZIONE', 'CHIUSA'] as const;
type Phase = (typeof PHASES)[number];

const PHASE_LABEL: Record<Phase, string> = {
  SETUP: 'Setup',
  APERTA: 'Aperta',
  LAST_CALL: 'Last call',
  ESTRAZIONE: 'Estrazione',
  CHIUSA: 'Chiusa',
};

export default function RegiaPage() {
  // MOCK: fase evidenziata. NON è stato di dominio — placeholder locale per
  // mostrare l'indicatore. TODO(realtime): sostituire con channel "admin:phase".
  const [currentPhase] = React.useState<Phase>('APERTA');

  return (
    <Screen kicker="Regia" title="Pannello organizzatore">
      {/* Indicatore di fase */}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="tag">Fase serata</p>
        <ol
          aria-label="Fasi della serata"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {PHASES.map((phase) => {
            const active = phase === currentPhase;
            return (
              <li key={phase}>
                <span
                  aria-current={active ? 'step' : undefined}
                  style={{
                    display: 'inline-block',
                    padding: '6px 12px',
                    borderRadius: 999,
                    fontSize: 13,
                    fontWeight: active ? 700 : 500,
                    border: `1px solid ${
                      active ? 'var(--eden-violet)' : 'var(--night-700)'
                    }`,
                    background: active ? 'var(--eden-violet)' : 'transparent',
                    color: active ? 'var(--ink-0)' : 'var(--ink-300)',
                  }}
                >
                  {PHASE_LABEL[phase]}
                </span>
              </li>
            );
          })}
        </ol>
      </Card>

      {/* Dashboard statistiche — placeholder statici, mai ricalcolati dal client */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          marginTop: 16,
        }}
      >
        {/* TODO(realtime): admin:stats → presenze */}
        <Stat label="Presenze" value="—" tone="normale" />
        {/* TODO(realtime): admin:stats → gettoni venduti */}
        <Stat label="Gettoni venduti" value="—" tone="premium" />
        {/* TODO(realtime): admin:stats → ticket totali */}
        <Stat label="Ticket totali" value="—" tone="gold" />
      </div>

      {/* Totem condiviso (demo isolato/sostituibile).
          level mock — TODO(realtime): totem_level() risolto a monte. */}
      <Card style={{ marginTop: 16 }}>
        <p className="tag">Totem serata</p>
        <Totem level={2} />
      </Card>

      {/* Controlli — placeholder, nessuna business logic nel client */}
      <Card
        style={{
          marginTop: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <p className="tag">Controlli</p>
        {/* TODO(RPC): start_session(30) → countdown 30s server-side */}
        <Button
          variant="primary"
          onClick={() => {
            /* TODO(RPC): start_session(30) */
          }}
        >
          Lancia sessione 30s
        </Button>
        {/* TODO(RPC): run_draw() → estrazione vincitore */}
        <Button
          variant="ghost"
          onClick={() => {
            /* TODO(RPC): run_draw() */
          }}
        >
          Estrai
        </Button>
      </Card>
    </Screen>
  );
}
