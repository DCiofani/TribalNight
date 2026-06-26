import 'server-only';

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// lib/db.ts — data-access layer di produzione di Totem Night.
//
// È il "PostgREST nostro": per ogni richiesta autenticata replica BYTE PER BYTE
// ciò che fa tests/db.mjs::actAs() — con la sola differenza che COMMITTA invece di
// fare rollback (qui le scritture devono persistere).
//
//   begin;
//   set local role authenticated;                              -- mai owner
//   select set_config('request.jwt.claims', $1, true);          -- local-to-tx
//   <fn(client)>                                                -- RPC o SELECT (RLS)
//   commit;                                                     -- rollback+throw on error
//
// `set local role` e `set_config(..., true)` sono LOCAL alla transazione → a fine
// tx la connessione torna "pulita" al pool. È ciò che rende il pattern sicuro con
// pgbouncer in transaction-mode: nessun leak di identità tra richieste.
//
// CONTRATTO CLAIMS (fisso, identico a tests/db.mjs):
//   ospite : { sub }                                  -> app_role()='guest'
//   staff  : { sub, app_metadata: { role: 'cassa'|'regia'|'admin' } }
// `sub` DEVE essere un UUID valido: auth.uid() (vedi 0000_prelude.sql) fa il cast a
// uuid e altrimenti esplode.
//
// server-only: questo modulo apre connessioni al DB con la URL `authenticator` e
// non deve MAI finire nel bundle client.
// ─────────────────────────────────────────────────────────────────────────────

// Pool singleton LAZY. NON va creato (né DATABASE_URL validata) a import-time:
// `next build` importa i moduli delle route per leggerne la config → un throw qui
// romperebbe il build statico (che non ha né deve avere creds DB). Il pool si crea
// alla PRIMA query e fallisce solo allora se DATABASE_URL manca (runtime).
// In dev Next ricarica i moduli ad ogni HMR: memoizziamo su globalThis per non
// accumulare pool/connessioni. `max` <= capacità lato client di pgbouncer.
const globalForPool = globalThis as unknown as { __totemPgPool?: Pool };

function getPool(): Pool {
  if (globalForPool.__totemPgPool) return globalForPool.__totemPgPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL non impostata: il backend si connette come `authenticator` ' +
        '(es. postgres://authenticator:...@pgbouncer:6432/...).',
    );
  }
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // Le tx sono corte e a singola istruzione: un cap basso protegge da query
    // appese (p.es. close_session che cicla su tutti i taps va su un endpoint
    // dedicato con timeout proprio, non sul path caldo).
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15000),
    idleTimeoutMillis: 30000,
  });
  globalForPool.__totemPgPool = pool;
  return pool;
}

// Forma minima dei claims accettati da withAuth. Volutamente lasca su app_metadata
// per non duplicare il contratto: il DB (app_role/is_staff/auth.uid) è l'autorità.
export type AuthClaims = {
  sub: string;
  app_metadata?: { role?: 'cassa' | 'regia' | 'admin' } & Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * withAuth(claims, fn): esegue `fn` dentro UNA transazione in cui il ruolo è
 * `authenticated` e i claims JWT sono iniettati via set_config(..., true).
 * COMMITTA al successo; su errore fa ROLLBACK e ri-lancia. Rilascia sempre la
 * connessione. È actAs() di tests/db.mjs con commit.
 *
 * NB: `fn` riceve il PoolClient della transazione: tutte le query fatte con quel
 * client vedono il ruolo `authenticated` + i claims. Non usare `pool.query` dentro
 * `fn` (girerebbe come `authenticator`, fuori dalla tx).
 */
export async function withAuth<T>(
  claims: AuthClaims,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // rollback best-effort: la connessione viene comunque rilasciata sotto.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * query(text, params): helper per query SENZA contesto utente — gira come il ruolo
 * di connessione (`authenticator`, NOINHERIT senza privilegi propri) e NON è dentro
 * la tx `authenticated`. Da usare per health-check o per codice di servizio che
 * apre la propria tx. Per qualunque accesso ai dati utente usare withAuth.
 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params as unknown[] | undefined);
}
