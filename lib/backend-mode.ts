// Flag di modalità backend (Fase 3 — strangler, feature-flagged).
//
// Il client può parlare col backend NUOVO (route /api/*, Fase 2) MANTENENDO il path
// Supabase storico, scelto a RUNTIME da questo flag. Default = 'supabase' così il push
// su main NON rompe la prod finché il backend prod non è wired (Fase 5).
//
// Si attiva impostando l'env pubblica NEXT_PUBLIC_BACKEND=api (qualsiasi altro valore,
// o assente, resta su supabase). È NEXT_PUBLIC_* perché deve essere leggibile nel bundle
// client: Next la inietta a build-time come costante, quindi il dead-code-elimination
// rimuove il ramo non scelto. NIENTE 'server-only': gira anche nel browser.
export const USE_API = (process.env.NEXT_PUBLIC_BACKEND ?? 'supabase') === 'api';
