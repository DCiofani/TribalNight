// TEMP — swappabile quando arriva il design (Claude Design).
// Schermata CASSA (staff) — §10 checklist UI · §7.2 ricarica · §7.3 consumo.
// Presentazione isolata dalla logica: NESSUN ricalcolo saldi/ticket nel client.
// I valori veri arrivano da RPC SECURITY DEFINER + Realtime (M2/M3): qui placeholder.
'use client';

import React, { useState } from 'react';
import { Screen, Card, Button, Stat } from '@/components/ui';
import Totem from '@/components/Totem';

type Azione = 'ricarica' | 'consuma';

export default function CassaPage() {
  // Stato SOLO di presentazione (toggle azione + valore campo ricerca).
  // Nessuna business logic: la conferma transazione passerà da RPC server-side.
  const [azione, setAzione] = useState<Azione>('ricarica');
  const [ricerca, setRicerca] = useState('');

  return (
    <Screen kicker="Postazione staff" title="Cassa">
      {/* Gating ruolo — promemoria: l'accesso reale è protetto da RLS + ruolo cassa.
          TODO(RPC): bloccare la pagina se l'operatore non ha ruolo staff/cassa. */}
      <Card style={{ borderColor: 'var(--ember)' }}>
        <p className="tag" style={{ margin: 0 }}>Solo operatori cassa</p>
        <p style={{ margin: '6px 0 0', color: 'var(--ink-300)', fontSize: 14 }}>
          Le operazioni di ricarica e consumo muovono saldi e ticket solo via
          funzioni server (RPC). L&apos;app non sostituisce il controllo dell&apos;età.
        </p>
      </Card>

      {/* ① Scelta azione — due grandi bottoni (§10 "scelta azione"). */}
      <div
        role="group"
        aria-label="Scelta azione cassa"
        style={{ display: 'flex', gap: 12, marginTop: 16 }}
      >
        <Button
          variant={azione === 'ricarica' ? 'primary' : 'ghost'}
          onClick={() => setAzione('ricarica')}
        >
          ① Ricarica
        </Button>
        <Button
          variant={azione === 'consuma' ? 'primary' : 'ghost'}
          onClick={() => setAzione('consuma')}
        >
          ② Consuma
        </Button>
      </div>

      {/* Identificazione ospite — ricerca + scan QR/PIN (§7.3 "Ospite mostra QR/PIN"). */}
      <Card style={{ marginTop: 16 }}>
        <label
          htmlFor="cassa-ricerca-ospite"
          className="tag"
          style={{ display: 'block', marginBottom: 8 }}
        >
          Cerca ospite (nome o PIN)
        </label>
        <input
          id="cassa-ricerca-ospite"
          type="text"
          inputMode="text"
          autoComplete="off"
          placeholder="Es. Marco R. — oppure PIN"
          value={ricerca}
          onChange={(e) => setRicerca(e.target.value)}
          style={{
            width: '100%',
            padding: '12px 14px',
            borderRadius: 12,
            fontSize: 16,
            color: 'var(--ink-0)',
            background: 'var(--night-800)',
            border: '1px solid var(--night-700)',
            outlineColor: 'var(--eden-lavender)',
          }}
        />

        <div style={{ marginTop: 12 }}>
          {/* TODO(RPC): apertura scanner QR + lookup ospite via RPC SECURITY DEFINER. */}
          <Button variant="ghost" disabled>
            Scansiona QR ospite (in arrivo)
          </Button>
        </div>
      </Card>

      {/* Riepilogo ospite selezionato — saldi separati Normali/Premium (§5).
          Front-end NON calcola: placeholder statici finché non arriva il dato. */}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '20px 0 8px' }}>
        {/* TODO(realtime): livello totem dell'ospite selezionato → totem_level(). */}
        <Totem level={0} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* TODO(RPC): saldo_normale dell'ospite selezionato. */}
        <Stat label="Saldo normali" value="—" tone="normale" />
        {/* TODO(RPC): saldo_premium dell'ospite selezionato. */}
        <Stat label="Saldo premium" value="—" tone="premium" />
      </div>

      {/* Pannello azione — cambia in base al toggle. Solo presentazione. */}
      {azione === 'ricarica' ? (
        <Card style={{ marginTop: 16 }}>
          <p className="tag" style={{ margin: 0 }}>Ricarica — §7.2</p>
          <p style={{ margin: '6px 0 12px', color: 'var(--ink-300)', fontSize: 14 }}>
            Scegli tipo (normale/premium) e quantità, incassa, poi conferma.
          </p>
          {/* TODO(RPC topup): la conferma chiamerà transaction(ricarica, tipo, qta)
              → saldo += n. Idempotente, server-authoritative. */}
          <Button disabled>Conferma ricarica (TODO RPC)</Button>
        </Card>
      ) : (
        <Card style={{ marginTop: 16 }}>
          <p className="tag" style={{ margin: 0 }}>Consuma — §7.3</p>
          <p style={{ margin: '6px 0 12px', color: 'var(--ink-300)', fontSize: 14 }}>
            Seleziona il drink dal listino: il saldo del tipo corrispondente scala
            di 1 (bloccato se a 0).
          </p>
          {/* TODO(RPC): listino drink (normali/premium) caricato server-side. */}
          {/* TODO(RPC consume): la conferma chiamerà transaction(consumo) → saldo--,
              ticket_consumo += (normale 4 | premium 8). */}
          <Button disabled>Conferma consumo (TODO RPC)</Button>
        </Card>
      )}
    </Screen>
  );
}
