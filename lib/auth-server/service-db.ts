import 'server-only';

// service-db.ts — UNICO pool di servizio per le tabelle auth.* (staff_users, refresh_tokens).
//
// Perché un modulo dedicato: queste tabelle NON sono leggibili dal ruolo `authenticated`
// (nessun grant: sono dati di sistema, mai esposti via RLS al client). Quindi NON si usa
// lib/db.ts::withAuth (che fa `set local role authenticated`). Si usa un pool DEDICATO che
// si connette con un ruolo owner/service ed esegue query DIRETTE (nessun SET ROLE), come
// tests/db.mjs fa il setup() da owner. Il pool è separato da quello applicativo: non
// eredita mai claims utente.
//
// ── CONNECTION STRING (FAIL FAST, niente fallback silenzioso) ────────────────────────
// Si risolve da AUTH_DB_URL, altrimenti DATABASE_URL_DIRECT. Deve essere una URL DIRETTA
// al Postgres plugin (bypassando pgbouncer) con un ruolo owner/service.
//
// NON si fa fallback su DATABASE_URL: quella è la URL del ruolo `authenticator`, che è
// NOINHERIT e NON ha alcun grant su auth.* → userebbe un ruolo che non può leggere
// staff_users/refresh_tokens e ogni query auth fallirebbe (login/refresh in 500), oppure,
// peggio, maschererebbe un errore di configurazione. Meglio fallire SUBITO e chiaro al
// primo uso, con un messaggio che indica esattamente quale env impostare.

import pg from 'pg';

let _servicePool: pg.Pool | null = null;

// Pool di servizio (lazy singleton). Lancia con messaggio chiaro se manca la connection
// string dedicata: NON degrada mai su DATABASE_URL (authenticator).
export function serviceDb(): pg.Pool {
  if (_servicePool) return _servicePool;

  const connectionString =
    process.env.AUTH_DB_URL || process.env.DATABASE_URL_DIRECT;
  if (!connectionString) {
    throw new Error(
      'service-db: connection string di servizio assente. Imposta AUTH_DB_URL ' +
        '(o DATABASE_URL_DIRECT) a una URL DIRETTA al Postgres plugin con ruolo ' +
        'owner/service. NON si usa DATABASE_URL (authenticator NOINHERIT, senza grant ' +
        'su auth.*): le query su auth.staff_users / auth.refresh_tokens fallirebbero.',
    );
  }

  // Pool piccolo: il traffico auth (login/refresh/logout) è basso e fuori dal path caldo
  // dei tap. Le query girano as-is (ruolo di connessione = owner/service), MAI dentro
  // `set local role authenticated`.
  _servicePool = new pg.Pool({ connectionString, max: 4 });
  return _servicePool;
}

// Per i test/shutdown puliti: chiude il pool unico.
export async function closeServiceDb(): Promise<void> {
  if (_servicePool) {
    await _servicePool.end();
    _servicePool = null;
  }
}
