// TEMP — swappabile quando arriva il design / testo legale definitivo.
// Pagina Termini & Condizioni: placeholder per chiudere il gate legale dell'onboarding.
// TODO(content): sostituire con il testo validato (vedi docs/totem-night_termini-e-condizioni_BOZZA.md)
// e con la validazione legale DPR 430/2001 + GDPR (gate di rilascio, vedi PLAN.md R-08/OQ6).
import Link from 'next/link';
import { Screen, Card } from '@/components/ui';

export default function TermsPage() {
  return (
    <Screen kicker="Legale" title="Termini & Condizioni">
      <Card>
        <p style={{ marginTop: 0, color: 'var(--ink-300)', fontSize: 14, lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--ink-0)' }}>Bozza — non definitiva.</strong> Testo
          provvisorio in attesa di validazione legale.
        </p>
        <ul style={{ color: 'var(--ink-300)', fontSize: 14, lineHeight: 1.7, paddingLeft: 18 }}>
          <li>
            <strong style={{ color: 'var(--ink-0)' }}>Nessun rimborso:</strong> le consumazioni
            acquistate non sono riconvertibili in denaro.
          </li>
          <li>
            <strong style={{ color: 'var(--ink-0)' }}>Estrazione:</strong> a fine serata si tiene
            un&apos;estrazione pesata sui ticket accumulati; l&apos;esito è verificabile (seed +
            snapshot registrati).
          </li>
          <li>
            <strong style={{ color: 'var(--ink-0)' }}>Privacy (GDPR):</strong> trattiamo il nome
            che fornisci per la gestione della serata.
          </li>
          <li>Niente alcol a minori: l&apos;app non sostituisce il controllo dell&apos;età alla cassa.</li>
        </ul>
        <p style={{ color: 'var(--ink-300)', fontSize: 13, lineHeight: 1.6 }}>
          Testo completo della bozza: <code>docs/totem-night_termini-e-condizioni_BOZZA.md</code>.
        </p>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Link href="/onboarding">← Torna all&apos;ingresso</Link>
      </div>
    </Screen>
  );
}
