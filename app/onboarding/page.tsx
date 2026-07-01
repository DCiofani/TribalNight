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
// Cadenza fra un livello e il successivo durante la FASE 1 (ignite lento). A ~520ms ogni step
// innesca il crossfade CSS interno .6s del Totem: i passaggi si sovrappongono leggermente →
// colori/glow/aura salgono in modo continuo, senza scatti. Non scendere sotto ~500ms.
const IGNITE_STEP_MS = 520;

// Marker temporali assoluti (ms dall'avvio della coreografia) delle fasi successive all'ignite.
// IGNITE: 6 × 520 = 3120ms. Poi picco vivo, decolor, reveal in stagger, handoff fluido.
const T_PEAK = 3120; // FASE 2 — picco: il Totem resta a 6 e pulsa (animazioni interne infinite).
const T_DECOLOR = 4020; // FASE 3 — decolor: salto 6→1, il crossfade .6s del Totem lo "spegne".
const T_REVEAL = 4780; // FASE 4 — reveal: spuntano gli elementi di scena in stagger.
const T_HANDOFF = 5980; // FASE 5 — handoff: l'overlay fa fade-out.
const T_PUSH = 6240; // router.push a metà del fade → crossfade percepito con /guest.
const T_FAILSAFE = 6600; // FAILSAFE: forza la navigazione se per qualsiasi motivo non è avvenuta.

// Ramo reduced-motion: mostra il Totem già acceso + reveal statico, poi naviga subito.
const REDUCED_HOLD_MS = 600;

// Macchina a fasi della coreografia rituale (puramente estetica, parte DOPO la registrazione).
type IgnitePhase = 'idle' | 'ignite' | 'peak' | 'decolor' | 'reveal' | 'handoff';

export default function OnboardingPage() {
  const router = useRouter();
  const [nome, setNome] = useState('');
  const [accettato, setAccettato] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  // Fase d'accensione: 'ignitePhase' pilota l'overlay rituale; 'igniteLevel' fa salire il Totem.
  // 'igniting' è derivato: l'overlay è attivo per qualsiasi fase diversa da 'idle'.
  const [ignitePhase, setIgnitePhase] = useState<IgnitePhase>('idle');
  const [igniteLevel, setIgniteLevel] = useState(0);
  const igniting = ignitePhase !== 'idle';
  // Tracciamo i timer per ripulirli in caso di smontaggio durante l'animazione.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Naviga a /guest UNA SOLA volta (push a metà fade + failsafe non devono navigare due volte).
  const navigatedRef = useRef(false);

  const prefersReducedMotion = useCallback(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const goGuest = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push('/guest');
  }, [router]);

  // Riproduce la coreografia rituale a fasi (ignite lento → picco → decolor → reveal → handoff)
  // e POI naviga a /guest. La registrazione è già avvenuta e l'id è persistito prima di qui.
  // Rispetta prefers-reduced-motion: mostra il Totem acceso + reveal statico e naviga subito.
  const playIgniteThenGo = useCallback(() => {
    const schedule = (fn: () => void, ms: number) => {
      timersRef.current.push(setTimeout(fn, ms));
    };

    if (prefersReducedMotion()) {
      // Ramo ridotto: niente rampa né timer di fase. Totem già al picco, reveal statico,
      // breve pausa leggibile, poi naviga. Il failsafe copre comunque questo ramo.
      setIgnitePhase('reveal');
      setIgniteLevel(IGNITE_PEAK);
      schedule(goGuest, REDUCED_HOLD_MS);
      schedule(goGuest, T_FAILSAFE);
      return;
    }

    // FASE 1 — IGNITE lento: level 1..6 a step di IGNITE_STEP_MS (crossfade .6s sovrapposto).
    setIgnitePhase('ignite');
    for (let lvl = 1; lvl <= IGNITE_PEAK; lvl++) {
      schedule(() => setIgniteLevel(lvl), lvl * IGNITE_STEP_MS);
    }
    // FASE 2 — PEAK: resta a 6, pulsa da solo (animazioni interne infinite del Totem).
    schedule(() => setIgnitePhase('peak'), T_PEAK);
    // FASE 3 — DECOLOR: un solo salto 6→1, il crossfade .6s del Totem lo "spegne" con fluidità.
    schedule(() => {
      setIgnitePhase('decolor');
      setIgniteLevel(1);
    }, T_DECOLOR);
    // FASE 4 — REVEAL: spuntano gli elementi di scena in stagger (gestiti dall'overlay).
    schedule(() => setIgnitePhase('reveal'), T_REVEAL);
    // FASE 5 — HANDOFF: l'overlay fa fade-out; il push parte a metà del fade → crossfade.
    schedule(() => setIgnitePhase('handoff'), T_HANDOFF);
    schedule(goGuest, T_PUSH);
    // FAILSAFE: l'utente non resta MAI bloccato, anche se un timer/render slitta.
    schedule(goGuest, T_FAILSAFE);
  }, [prefersReducedMotion, goGuest]);

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
      ignitePhase={ignitePhase}
      reducedMotion={prefersReducedMotion()}
    />
  );
}
