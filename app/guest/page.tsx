// TEMP — swappabile quando arriva il design (Claude Design).
//
// Schermata OSPITE (spec §10).
// PRESENTAZIONE isolata dalla logica: usa solo i primitivi UI e il Totem.
// Cablaggio M1-S3: dati LIVE da public.guests via useGuestState (RLS + Realtime).
// Il front-end NON calcola MAI saldi/ticket/livello: mostra la riga e basta.
'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Screen, Card, Button, Stat } from '@/components/ui';
import Totem from '@/components/Totem';
import { loadGuestId } from '@/lib/guest-session';
import { useGuestState } from '@/lib/useGuestState';

// Menù placeholder: il catalogo `drinks` reale è altro task (fuori scope S3).
const MENU: { nome: string; tipo: string }[] = [
  { nome: 'Cocktail della casa', tipo: 'Premium' },
  { nome: 'Birra alla spina', tipo: 'Normale' },
  { nome: 'Acqua / Soft drink', tipo: 'Normale' },
];

// Spezza il PIN in 4 caselle; "—" finché non c'è il valore.
function pinDigits(pin: string | null): string[] {
  const base = (pin ?? '').slice(0, 4).split('');
  while (base.length < 4) base.push('—');
  return base;
}

export default function GuestPage() {
  const router = useRouter();

  // guestId letto SOLO lato client (evita mismatch SSR): parte da undefined,
  // diventa string|null dopo il mount.
  const [guestId, setGuestId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const id = loadGuestId();
    if (!id) {
      // Ospite non registrato: torna all'onboarding.
      router.replace('/onboarding');
    }
    setGuestId(id);
  }, [router]);

  const {
    pin,
    saldoNormale,
    saldoPremium,
    ticketTotali,
    livelloTotem,
    error,
  } = useGuestState(guestId ?? null);

  const pin4 = pinDigits(pin);

  return (
    <Screen kicker="Ospite" title="Il tuo Totem">
      {/* Eroe centrale: livello autoritativo da livello_totem (DB), 0 in attesa. */}
      <Totem level={livelloTotem ?? 0} />

      {error && (
        <Card style={{ marginTop: 12, borderColor: 'var(--ember)' }}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-0)' }}>
            Impossibile caricare lo stato.
          </p>
        </Card>
      )}

      {/* Saldi: due tile affiancate (Normali / Premium). Solo lettura. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          marginTop: 8,
        }}
      >
        <Stat label="Saldo Normali" value={saldoNormale ?? '—'} tone="normale" />
        <Stat label="Saldo Premium" value={saldoPremium ?? '—'} tone="premium" />
      </div>

      {/* Ticket totali: tile a larghezza piena (GENERATED lato DB). */}
      <div style={{ marginTop: 12 }}>
        <Stat label="Ticket totali" value={ticketTotali ?? '—'} tone="normale" />
      </div>

      {/* Blocco "Mostra alla cassa": QR placeholder + PIN. */}
      <Card style={{ marginTop: 16 }}>
        <p className="tag">Mostra alla cassa</p>
        <h2 style={{ fontSize: 18, margin: '4px 0 12px' }}>Il tuo codice</h2>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          {/* QR firmato = TODO(M2/M3), fuori scope S3: resta placeholder. */}
          <div
            role="img"
            aria-label="Codice QR non ancora disponibile"
            style={{
              width: 180,
              height: 180,
              borderRadius: 12,
              border: '1px dashed var(--night-700)',
              background: 'var(--night-800)',
              color: 'var(--ink-300)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              fontSize: 13,
              padding: 12,
            }}
          >
            QR in arrivo
          </div>

          {/* PIN cassa: 4 caselle. Valore reale dalla propria riga (RLS-ok). */}
          <div style={{ width: '100%' }}>
            <p className="tag" style={{ marginBottom: 8 }}>
              PIN cassa
            </p>
            <div
              role="group"
              aria-label="PIN cassa"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 8,
              }}
            >
              {pin4.map((cifra, i) => (
                <div
                  key={i}
                  aria-hidden="true"
                  style={{
                    aspectRatio: '1 / 1',
                    borderRadius: 12,
                    border: '1px solid var(--night-700)',
                    background: 'var(--night-800)',
                    color: 'var(--ink-0)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 28,
                    fontWeight: 700,
                  }}
                >
                  {cifra}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Menù placeholder: catalogo `drinks` reale = altro task. */}
      <section style={{ marginTop: 16 }}>
        <p className="tag" style={{ marginBottom: 8 }}>
          Menù
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {MENU.map((voce, i) => (
            <Card
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span style={{ color: 'var(--ink-0)' }}>{voce.nome}</span>
              <span className="tag">{voce.tipo}</span>
            </Card>
          ))}
        </div>
      </section>

      {/* Azione segnaposto: lo stato si aggiorna da solo via Realtime. */}
      <div style={{ marginTop: 16 }}>
        <Button variant="ghost" disabled>
          Aggiorna stato
        </Button>
      </div>
    </Screen>
  );
}
