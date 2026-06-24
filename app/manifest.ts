import type { MetadataRoute } from 'next';
import { APP_CONFIG } from '@/lib/config';

// Manifest generato da config (vincolo 5: nome app sostituibile senza toccare codice).
// Next App Router lo serve a /manifest.webmanifest e lo linka automaticamente.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_CONFIG.name,
    short_name: APP_CONFIG.name,
    description: APP_CONFIG.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0a12',
    theme_color: APP_CONFIG.themeColor,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
