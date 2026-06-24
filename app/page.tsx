import Link from 'next/link';
import { APP_CONFIG } from '@/lib/config';

const ROUTES = [
  { href: '/onboarding', label: 'ingresso ospite + T&C', who: 'Ospite' },
  { href: '/guest', label: 'totem, wallet, arena tap', who: 'Ospite' },
  { href: '/cassa', label: 'ricarica & consumo', who: 'Staff cassa' },
  { href: '/regia', label: 'dashboard, fasi, estrazione', who: 'Regia/Admin' },
];

export default function Home() {
  return (
    <main>
      <p className="tag">Fondamenta · M1</p>
      <h1>{APP_CONFIG.name}</h1>
      <p style={{ color: 'var(--ink-300)' }}>
        Scaffold PWA mobile-first. Stato server-authoritative via Supabase RPC + Realtime.
      </p>
      <nav className="card" style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        {ROUTES.map((r) => (
          <Link key={r.href} href={r.href}>
            <strong>{r.href}</strong> — {r.label}{' '}
            <span className="tag" style={{ display: 'inline' }}>
              · {r.who}
            </span>
          </Link>
        ))}
      </nav>
    </main>
  );
}
