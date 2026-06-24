// /guest — ospite: totem, wallet (saldi/ticket), menù, arena tap, conversione.
// Placeholder di scaffold: wallet+totem realtime in M1-S3/M2; arena tap in M3.
export default function GuestPage() {
  return (
    <main>
      <p className="tag">Ospite · /guest</p>
      <h1>Il tuo Totem</h1>
      <div className="card">
        <p>Totem (livelli 0–6), saldi Normali/Premium, ticket, QR pagamento, arena tap.</p>
        <p style={{ color: 'var(--ink-300)' }}>Stato live via Realtime <code>guest:state</code>. Build: M2–M4.</p>
      </div>
    </main>
  );
}
