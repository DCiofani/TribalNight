'use client';
// Persistenza minimale lato client: SOLO l'id ospite (puntatore alla riga guests).
// Saldi/ticket/livello NON si memorizzano qui: si leggono live via useGuestState.
const GUEST_ID_KEY = 'tn_guest_id';

export function saveGuestId(id: string): void {
  try {
    localStorage.setItem(GUEST_ID_KEY, id);
  } catch {
    /* storage non disponibile: best-effort */
  }
}

export function loadGuestId(): string | null {
  try {
    return localStorage.getItem(GUEST_ID_KEY);
  } catch {
    return null;
  }
}

export function clearGuestId(): void {
  try {
    localStorage.removeItem(GUEST_ID_KEY);
  } catch {
    /* noop */
  }
}
