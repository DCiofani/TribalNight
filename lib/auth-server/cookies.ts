// server-only — helper cookie auth condiviso dalle route /api/auth/*.
//
// Due cookie, entrambi HttpOnly + Secure + SameSite=Strict:
//   tn_at  = access token (JWT firmato, TTL breve 10-15 min)
//   tn_rt  = refresh token opaco (random, ruotato ad ogni uso)
//
// SameSite=Strict: il browser NON allega questi cookie su NESSUNA richiesta
// cross-site, nemmeno le navigazioni top-level → mitigazione CSRF più forte di Lax.
//   - tn_rt è usato SOLO da POST /api/auth/refresh, sempre same-origin (fetch dal nostro
//     frontend): Strict non rompe alcun flusso ed elimina l'invio cross-site del refresh.
//   - tn_at è usato dalle fetch API same-origin del frontend (rpc/stream/guest read): anche
//     qui Strict è adeguato (non ci sono link cross-site che debbano arrivare già autenticati;
//     l'app fa boot e poi chiama /api/auth/anon|me per stabilire la sessione). Se in futuro
//     servisse un deep-link autenticato cross-site, riportare SOLO tn_at a 'lax'.
// Secure: solo HTTPS in prod. In sviluppo (NODE_ENV!=='production') lo allentiamo
// per permettere http://localhost senza TLS.
//
// Path '/' perché i cookie servono a TUTTE le API (rpc, stream, guest read), non
// solo a /api/auth.
import 'server-only';
import type { NextResponse } from 'next/server';

export const AT_COOKIE = 'tn_at';
export const RT_COOKIE = 'tn_rt';

const isProd = process.env.NODE_ENV === 'production';

// TTL dei cookie in secondi. NB: la SCADENZA AUTORITATIVA dell'access token è
// dentro il JWT (claim exp, verificata server-side); il Max-Age del cookie è solo
// un suggerimento al browser. Per il refresh (opaco) la scadenza autoritativa è in
// app_auth.refresh_tokens.expires_at. Teniamo i Max-Age allineati ai TTL del token.
export const AT_MAX_AGE = 15 * 60; // 15 min
export const RT_MAX_AGE = 24 * 60 * 60; // 24h (durata di una serata)

type SetCookie = NextResponse['cookies']['set'];

// Opzioni base condivise. httpOnly impedisce l'accesso da JS (niente leak del
// token via XSS); il browser lo allega da solo a ogni richiesta same-origin.
// sameSite='strict': nessun invio cross-site (CSRF hardening), default per entrambi.
function baseOpts(maxAge: number, sameSite: 'strict' | 'lax' = 'strict') {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite,
    path: '/',
    maxAge,
  } as const;
}

// Imposta l'access cookie sulla response.
export function setAccessCookie(res: NextResponse, token: string): void {
  (res.cookies.set as SetCookie)(AT_COOKIE, token, baseOpts(AT_MAX_AGE));
}

// Imposta il refresh cookie sulla response.
export function setRefreshCookie(res: NextResponse, token: string): void {
  (res.cookies.set as SetCookie)(RT_COOKIE, token, baseOpts(RT_MAX_AGE));
}

// Cancella entrambi i cookie (logout / refresh non valido). maxAge:0 + valore vuoto
// = il browser li rimuove immediatamente. Gli attributi (sameSite/secure/path) devono
// combaciare con quelli di set per garantire la cancellazione.
export function clearAuthCookies(res: NextResponse): void {
  (res.cookies.set as SetCookie)(AT_COOKIE, '', baseOpts(0));
  (res.cookies.set as SetCookie)(RT_COOKIE, '', baseOpts(0));
}
