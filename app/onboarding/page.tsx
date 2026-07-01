// Schermata Ospite / onboarding §7.1 — design Claude implementato fedelmente.
// LOGICA invariata: anon sign-in -> register_guest (current_event) -> persisti
// guestId in localStorage -> /guest. Nessun ricalcolo: la riga guests è autoritativa.
'use client';

import React, { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Onboarding from '@/components/screens/Onboarding';
import { createClient } from '@/lib/supabase/client';
import { USE_API } from '@/lib/backend-mode';
import { registerGuest, RpcError } from '@/lib/rpc';
import { saveGuestId } from '@/lib/guest-session';

// Livello d'apice dell'animazione rituale (il Totem ha 6 livelli — vedi components/Totem.tsx).
const IGNITE_PEAK = 6;
// Cadenza fra un livello e il successivo: 0→6 a step di ~300ms ≈ ~1.8s totali (+ una pausa
// finale a livello pieno prima di navigare). Resta nella finestra richiesta di ~1.6–2.2s.
const IGNITE_STEP_MS = 300;
const IGNITE_HOLD_MS = 360;

export default function OnboardingPage() {
  const router = useRouter();
  const [nome, setNome] = useState('');
  const [accettato, setAccettato] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  // Fase d'accensione: 'igniting' attiva l'overlay rituale; 'igniteLevel' fa salire il Totem.
  const [igniting, setIgniting] = useState(false);
  const [igniteLevel, setIgniteLevel] = useState(0);
  // Tracciamo i timer per ripulirli in caso di smontaggio durante l'animazione.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const prefersReducedMotion = useCallback(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // Riproduce l'accensione (Totem 0→6) poi naviga. Rispetta prefers-reduced-motion:
  // se attivo salta la rampa e va subito a /guest.
  const playIgniteThenGo = useCallback(() => {
    setIgniting(true);

    if (prefersReducedMotion()) {
      setIgniteLevel(IGNITE_PEAK);
      router.push('/guest');
      return;
    }

    for (let lvl = 1; lvl <= IGNITE_PEAK; lvl++) {
      const t = setTimeout(() => setIgniteLevel(lvl), lvl * IGNITE_STEP_MS);
      timersRef.current.push(t);
    }
    const go = setTimeout(
      () => router.push('/guest'),
      IGNITE_PEAK * IGNITE_STEP_MS + IGNITE_HOLD_MS,
    );
    timersRef.current.push(go);
  }, [prefersReducedMotion, router]);

  React.useEffect(
    () => () => {
      timersRef.current.forEach(clearTimeout);
    },
    [],
  );

  const nomeValido = nome.trim().length > 0;
  // Durante l'accensione il form è bloccato (igniting) per evitare doppi submit.
  const puoEntrare = nomeValido && accettato && !submitting && !igniting;

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
        // grazie a credentials:'include'.
        const res = await fetch('/api/auth/anon', {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          throw new RpcError('Sign-in anonimo non riuscito', { code: String(res.status) });
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
      const guest = await registerGuest(supabase, nome);

      // Persisti SOLO l'id (puntatore). PIN/saldi NON vanno in localStorage.
      saveGuestId(guest.id);

      // SUCCESSO: invece di navigare subito, riproduci l'accensione rituale del Totem
      // (level 0→6) e POI vai a /guest. La registrazione è già avvenuta e l'id è persistito.
      playIgniteThenGo();
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
    <Onboarding
      nome={nome}
      onNome={setNome}
      accettato={accettato}
      onAccettato={setAccettato}
      submitting={submitting}
      errore={errore}
      canSubmit={puoEntrare}
      onSubmit={handleEntra}
      igniting={igniting}
      igniteLevel={igniteLevel}
    />
  );
}
