// /cassa — staff: ricarica (topup) e consumo (consume). Accesso solo ruolo staff.
// Placeholder di scaffold: ricarica in M1-S3 (T-M1-11), consumo in M2.
export default function CassaPage() {
  return (
    <main>
      <p className="tag">Staff cassa · /cassa</p>
      <h1>Cassa</h1>
      <div className="card">
        <p>① Ricarica (<code>topup</code>, POS/contanti) · ② Consuma (<code>consume</code>, scan QR su guest.id).</p>
        <p style={{ color: 'var(--ink-300)' }}>Gating ruolo staff. Build: ricarica M1-S3, consumo M2.</p>
      </div>
    </main>
  );
}
