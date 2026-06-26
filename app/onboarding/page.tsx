// TEMP — swappabile quando arriva il design (Claude Design).
// Schermata Ospite / onboarding §7.1 — presentazione isolata dalla logica.
// Cablaggio M1-S3: anon sign-in -> register_guest (current_event) -> persisti
// guestId in localStorage -> /guest. Nessun ricalcolo: la riga guests è autoritativa.
'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Screen, Card, Button, Stat } from '@/components/ui';
import Totem from '@/components/Totem';
import { createClient } from '@/lib/supabase/client';
import { USE_API } from '@/lib/backend-mode';
import { registerGuest, RpcError } from '@/lib/rpc';
import { saveGuestId } from '@/lib/guest-session';

export default function OnboardingPage() {
  const router = useRouter();
  const [nome, setNome] = useState('');
  const [accettato, setAccettato] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  const nomeValido = nome.trim().length > 0;
  const puoEntrare = nomeValido && accettato && !submitting;

  async function handleEntra(e: React.FormEvent) {
    e.preventDefault();
    if (!puoEntrare) return;

    setSubmitting(true);
    setErrore(null);

    try {
      // Istanza supabase usata SOLO nel path supabase. In API mode registerGuest
      // ignora il client (parla col backend via fetch), ma la teniamo per mantenere
      // la firma del wrapper invariata e non toccare il resto del flusso.
      const supabase = createClient();

      if (USE_API) {
        // Path API (backend nuovo): identità anonima emessa dal server con cookie
        // di sessione HttpOnly. POST /api/auth/anon -> { sub }; il cookie viaggia
        // grazie a credentials:'include'. Idempotenza non necessaria: una seconda
        // identità anonima non perde la riga guests finché il guestId è persistito.
        const res = await fetch('/api/auth/anon', {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          throw new RpcError('Sign-in anonimo non riuscito', {
            code: String(res.status),
          });
        }
      } else {
        // Path supabase (default): sessione anonima idempotente, firma solo se assente.
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData.session) {
          const { error: authErr } = await supabase.auth.signInAnonymously();
          if (authErr) throw authErr;
        }
      }

      // register_guest risolve l'evento corrente internamente (current_event()).
      // Wrapper unico: in API mode chiama POST /api/guest/register, altrimenti la RPC.
      const guest = await registerGuest(supabase, nome);

      // Persisti SOLO l'id (puntatore). PIN/saldi NON vanno in localStorage.
      saveGuestId(guest.id);

      router.push('/guest');
    } catch (err) {
      if (err instanceof RpcError && err.code === 'NO_EVENT') {
        setErrore('Nessun evento attivo. Riprova più tardi.');
      } else if (err instanceof RpcError && err.code === '42501') {
        setErrore('Operazione non consentita.');
      } else {
        setErrore('Impossibile completare l’accesso. Riprova.');
      }
      setSubmitting(false);
    }
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

        {/* Errore inline — riusa la Card con accento ember (no dettagli RLS all'utente). */}
        {errore && (
          <Card style={{ marginBottom: 16, borderColor: 'var(--ember)' }}>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-0)' }}>{errore}</p>
          </Card>
        )}

        <Button type="submit" variant="primary" disabled={!puoEntrare}>
          {submitting ? 'Entro…' : 'Entra'}
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
