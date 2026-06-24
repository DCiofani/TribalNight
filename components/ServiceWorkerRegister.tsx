'use client';

import { useEffect } from 'react';

// Registra il service worker solo in produzione (evita caching in dev).
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* installazione PWA best-effort */
      });
    }
  }, []);
  return null;
}
