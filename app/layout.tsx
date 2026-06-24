import type { Metadata, Viewport } from 'next';
import './globals.css';
import { APP_CONFIG } from '@/lib/config';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';

export const metadata: Metadata = {
  title: APP_CONFIG.name,
  description: APP_CONFIG.description,
  // manifest e icone sono auto-linkati da app/manifest.ts e app/apple-icon.png
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: APP_CONFIG.name,
  },
};

export const viewport: Viewport = {
  themeColor: APP_CONFIG.themeColor,
  width: 'device-width',
  initialScale: 1,
  // pinch-to-zoom lasciato attivo (accessibilità WCAG 1.4.4)
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
