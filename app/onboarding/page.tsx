// /onboarding — ospite: anonymous sign-in → T&C → register_guest (build: M1-S3, T-M1-10).
// Placeholder di scaffold: la logica RPC arriva nello sprint M1-S3.
export default function OnboardingPage() {
  return (
    <main>
      <p className="tag">Ospite · /onboarding</p>
      <h1>Ingresso</h1>
      <div className="card">
        <p>Flusso: anonymous sign-in → nome → accettazione T&amp;C → <code>register_guest</code>.</p>
        <p style={{ color: 'var(--ink-300)' }}>Implementazione: M1-S3 (T-M1-10).</p>
      </div>
    </main>
  );
}
