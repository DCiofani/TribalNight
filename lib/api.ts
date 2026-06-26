// Helper fetch tipizzati per il backend NUOVO (route /api/*, Fase 2).
//
// UNICO punto da cui i wrapper client (rpc/events/auth) parlano con le route /api quando
// USE_API è attivo. NIENTE 'server-only': gira nel browser. NON importa lib/db né
// lib/auth-server (server-only): comunica solo via HTTP con le route.
//
// Contratto delle route (vedi app/api/**):
//   - sessione via cookie HttpOnly (tn_at/tn_rt) gestiti dalle route auth → SEMPRE
//     credentials:'include' (anche same-origin: i cookie HttpOnly non sono nel JS, e così
//     restano coerenti se un giorno l'API vivesse su un sotto-dominio).
//   - body JSON con Content-Type: application/json sulle mutazioni.
//   - su risposta non-ok il body è { error: <messaggio> } (italiano e safe lato handleError):
//     lo rilanciamo come RpcError(error|statusText) per uniformità col path supabase.
import { RpcError } from '@/lib/rpc';

// Forma minima del body d'errore delle route /api (vedi app/api/_lib.ts + auth/_lib.ts).
type ApiErrorBody = { error?: unknown };

// Estrae un messaggio utente dalla risposta non-ok. Prova il body JSON { error },
// poi ripiega su statusText. Non lancia durante il parsing (una risposta non-JSON
// non deve mascherare l'errore HTTP originale).
async function errorFromResponse(res: Response): Promise<RpcError> {
  let message = res.statusText || 'Errore di rete';
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (typeof body?.error === 'string' && body.error) message = body.error;
  } catch {
    // body non-JSON o vuoto: teniamo statusText.
  }
  // code = stringa dello status HTTP, così i chiamanti possono discriminare (es. 401/404)
  // come facevano coi code PostgREST nel path supabase.
  return new RpcError(message, { code: String(res.status) });
}

// Parsing della risposta ok. 204/205 (No Content) → null; altrimenti JSON tipizzato.
async function parseOk<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.status === 205) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

// GET tipizzato. `path` è relativo (es. '/api/event/current').
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw await errorFromResponse(res);
  return parseOk<T>(res);
}

// POST tipizzato con body JSON opzionale.
export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return parseOk<T>(res);
}

// PATCH tipizzato con body JSON opzionale.
export async function apiPatch<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return parseOk<T>(res);
}

// DELETE tipizzato con body JSON opzionale.
// Senza body (default): comportamento INVARIATO — solo header Accept, nessun body —
// così i chiamanti esistenti (es. apiDelete('/api/...')) non cambiano.
// Con body: aggiunge Content-Type: application/json e serializza il body, come apiPost
// (serve a regia deleteDrink → DELETE /api/regia/drink { p_drink }, che legge il JSON).
export async function apiDelete<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'DELETE',
    credentials: 'include',
    headers:
      body === undefined
        ? { Accept: 'application/json' }
        : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return parseOk<T>(res);
}
