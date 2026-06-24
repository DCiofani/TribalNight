// /regia — regia/admin: dashboard live, controllo fasi, sessioni tap, estrazione, menù/prezzi.
// Placeholder di scaffold: fasi e sessioni in M3, estrazione in M4, gestione menù in M2/M5.
export default function RegiaPage() {
  return (
    <main>
      <p className="tag">Regia/Admin · /regia</p>
      <h1>Regia</h1>
      <div className="card">
        <p>Fasi (<code>set_phase</code>), sessioni tap, classifica live, estrazione (<code>run_draw</code>), menù/prezzi.</p>
        <p style={{ color: 'var(--ink-300)' }}>Build: M3 (sessioni), M4 (estrazione), M2/M5 (menù).</p>
      </div>
    </main>
  );
}
