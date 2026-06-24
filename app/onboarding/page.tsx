// TEMP — swappabile quando arriva il design (Claude Design).
// Schermata Ospite / onboarding §7.1 — presentazione isolata dalla logica.
// Nessuna business logic nel client: saldi/ticket sono placeholder statici (vincolo dati).
'use client';

import React, { useState } from 'react';
import { Screen, Card, Button, Stat } from '@/components/ui';
import Totem from '@/components/Totem';

export default function OnboardingPage() {
  const [nome, setNome] = useState('');
  const [accettato, setAccettato] = useState(false);

  const nomeValido = nome.trim().length > 0;
  const puoEntrare = nomeValido && accettato;

  function handleEntra(e: React.FormEvent) {
    e.preventDefault();
    if (!puoEntrare) return;
    // TODO(RPC): anonymous sign-in (Supabase auth.signInAnonymously)
    // TODO(RPC): register_guest(current_event, nome.trim()) — SECURITY DEFINER
    // Dopo la registrazione: il PIN/QR dell'ospite verrà generato e mostrato (M2/M3).
  }

  return (
    <Screen kicker="Totem Night" title="Benvenuto">
      {/* Totem isolato/sostituibile — livello demo statico (placeholder) */}
      <Card style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <Totem level={0} />
      </Card>

      <form onSubmit={handleEntra} noValidate>
        <Card style={{ marginBottom: 16 }}>
          <label
            htmlFor="guest-nome"
            className="tag"
            style={{ display: 'block', marginBottom: 8 }}
          >
            Nome
          </label>
          <input
            id="guest-nome"
            name="nome"
            type="text"
            inputMode="text"
            autoComplete="given-name"
            required
            placeholder="Come ti chiami?"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            aria-required="true"
            style={{
              width: '100%',
              padding: '14px 12px',
              fontSize: 16,
              color: 'var(--ink-0)',
              background: 'var(--night-900)',
              border: '1px solid var(--night-700)',
              borderRadius: 12,
              outline: 'none',
            }}
          />

          <label
            htmlFor="guest-tos"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              marginTop: 16,
              fontSize: 14,
              color: 'var(--ink-300)',
              lineHeight: 1.4,
              cursor: 'pointer',
            }}
          >
            <input
              id="guest-tos"
              name="tos"
              type="checkbox"
              checked={accettato}
              onChange={(e) => setAccettato(e.target.checked)}
              aria-required="true"
              style={{ marginTop: 2, width: 18, height: 18, accentColor: 'var(--eden-violet)', flex: '0 0 auto' }}
            />
            <span>
              Ho letto e accetto i{' '}
              <a href="/terms" target="_blank" rel="noopener noreferrer">
                Termini &amp; Condizioni
              </a>
              .
            </span>
          </label>
        </Card>

        <Button type="submit" variant="primary" disabled={!puoEntrare}>
          Entra
        </Button>
      </form>

      {/* Anteprima credito serata — placeholder statici, MAI ricalcolati nel client */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          marginTop: 16,
        }}
      >
        {/* TODO(RPC): saldo reale da get_guest_balance / Realtime (M2/M3) */}
        <Stat label="Credito" value="—" tone="normale" />
        {/* TODO(RPC): ticket reali da get_guest_tickets / Realtime (M2/M3) */}
        <Stat label="Ticket" value={0} tone="normale" />
      </div>

      <Card style={{ marginTop: 16 }}>
        <p className="tag" style={{ marginBottom: 6 }}>
          Prossimo passo
        </p>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-300)', lineHeight: 1.5 }}>
          Dopo l&apos;accesso ti verrà generato un{' '}
          <strong style={{ color: 'var(--ink-0)' }}>PIN / QR</strong> personale per
          ricevere crediti e ticket durante la serata.
          {/* TODO(RPC): PIN/QR generati lato server dopo register_guest (M2/M3). */}
        </p>
      </Card>
    </Screen>
  );
}
