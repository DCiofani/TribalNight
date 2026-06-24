// TEMP — swappabile quando arriva il design (Claude Design).
//
// Schermata OSPITE (spec §10).
// PRESENTAZIONE isolata dalla logica: usa solo i primitivi UI e il Totem.
// Il front-end NON calcola MAI saldi/ticket: tutti i valori sotto sono
// PLACEHOLDER STATICI marcati TODO(realtime guest:state). I dati veri
// arriveranno da RPC SECURITY DEFINER + Supabase Realtime (M2/M3).
//
// Questa pagina è un Server Component statico: nessuna interattività/stato
// richiesta qui, quindi niente 'use client'.
import React from 'react';
import { Screen, Card, Button, Stat } from '@/components/ui';
import Totem from '@/components/Totem';

// TODO(realtime guest:state): valori finti finché non arriva il payload reale.
// Tutto ciò che segue è segnaposto e NON va trattato come dato di dominio.
const MOCK = {
  // livello del totem 0–6 (mappato su totem_level()). Demo: valore intermedio.
  totemLevel: 3 as number,
  // saldi: il client mostra solo, non somma/sottrae mai.
  saldoNormali: 0,
  saldoPremium: 0,
  ticketTotali: 0,
  // PIN cassa: placeholder a 4 caselle finché non arriva da guest:state.
  pin: ['—', '—', '—', '—'],
  // menù: voci finte di esempio (tag = tipo). Sostituibili dal catalogo reale.
  menu: [
    { nome: 'Cocktail della casa', tipo: 'Premium' },
    { nome: 'Birra alla spina', tipo: 'Normale' },
    { nome: 'Acqua / Soft drink', tipo: 'Normale' },
  ] as { nome: string; tipo: string }[],
};

export default function GuestPage() {
  return (
    <Screen kicker="Ospite" title="Il tuo Totem">
      {/* Eroe centrale: Totem isolato/sostituibile. level già risolto a monte. */}
      {/* TODO(realtime guest:state): level arriverà da totem_level() via realtime. */}
      <Totem level={MOCK.totemLevel} />

      {/* Saldi: due tile affiancate (Normali / Premium). Valori = placeholder. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          marginTop: 8,
        }}
      >
        {/* TODO(realtime guest:state): saldo gettoni Normali */}
        <Stat label="Saldo Normali" value={MOCK.saldoNormali} tone="normale" />
        {/* TODO(realtime guest:state): saldo gettoni Premium */}
        <Stat label="Saldo Premium" value={MOCK.saldoPremium} tone="premium" />
      </div>

      {/* Ticket totali: tile a larghezza piena. Oro riservato ai momenti-premio
          (reveal vincitore, ticket appena guadagnati) — qui a riposo, accento neutro. */}
      <div style={{ marginTop: 12 }}>
        {/* TODO(realtime guest:state): conteggio ticket totali */}
        <Stat label="Ticket totali" value={MOCK.ticketTotali} tone="normale" />
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
          {/* QR placeholder: riquadro segnaposto. Il QR reale arriva da guest:state. */}
          {/* TODO(realtime guest:state): rimpiazza con il QR firmato della sessione. */}
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

          {/* PIN cassa: 4 caselle. Placeholder "—" finché non arriva il valore. */}
          <div style={{ width: '100%' }}>
            <p className="tag" style={{ marginBottom: 8 }}>
              PIN cassa
            </p>
            <div
              role="group"
              aria-label="PIN cassa, non ancora disponibile"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 8,
              }}
            >
              {/* TODO(realtime guest:state): cifre PIN reali della sessione */}
              {MOCK.pin.map((cifra, i) => (
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

      {/* Menù placeholder: voci finte con tag tipo. Sostituibili dal catalogo reale. */}
      <section style={{ marginTop: 16 }}>
        <p className="tag" style={{ marginBottom: 8 }}>
          Menù
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* TODO(realtime guest:state): lista voci menù dal catalogo reale */}
          {MOCK.menu.map((voce, i) => (
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

      {/* Azione segnaposto: nessuna logica collegata (presentazione). */}
      <div style={{ marginTop: 16 }}>
        {/* TODO(realtime guest:state): collegare ad azione reale (es. aggiorna stato). */}
        <Button variant="ghost" disabled>
          Aggiorna stato
        </Button>
      </div>
    </Screen>
  );
}
