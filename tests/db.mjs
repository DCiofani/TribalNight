// tests/db.mjs — harness REALE per i contract/RLS test di Totem Night (M1-S2).
//
// Nessun mock: parla con un Postgres reale (DATABASE_URL) sul quale sono già stati
// applicati prelude.sql (ruoli anon/authenticated/service_role + schema auth con
// auth.uid()/auth.jwt() che leggono current_setting('request.jwt.claims')) e la
// migrazione 0001_init.sql (schema v0.2: 14 RPC SECURITY DEFINER + RLS).
//
// Pattern di simulazione auth in Postgres (obbligatorio: gli RPC leggono il claim
// JWT via current_setting('request.jwt.claims')):
//   begin;
//   set local role authenticated;
//   select set_config('request.jwt.claims', <json>, true);   -- local alla tx
//   ...rpc / select...
//   rollback;                                                  -- pulizia per-test
//
// SECURITY DEFINER: le RPC girano come owner (superuser) e bypassano la RLS al loro
// interno; le SELECT/INSERT/UPDATE/DELETE dirette del test (role authenticated) sono
// invece soggette alla RLS — è esattamente ciò che i test RLS verificano.

import pg from 'pg';
import { randomUUID } from 'node:crypto';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL non impostata: i test richiedono un Postgres reale con prelude.sql + migrazione 0001_init.sql applicati.'
  );
}

export const pool = new pg.Pool({ connectionString, max: 8 });

export function randUuid() {
  return randomUUID();
}

// ──────────────────────────────────────────────────────────────────────────────
// Claims helper — forma esatta letta da app_role()/auth.uid() (vedi prelude.sql).
//   OSPITE  : { sub }                                  -> app_role()='guest', is_staff()=false
//   CASSA   : { sub, app_metadata:{ role:'cassa' } }   -> is_staff()=true,  is_staff('regia')=false
//   REGIA   : { sub?, app_metadata:{ role:'regia' } }  -> is_staff()=true,  is_staff('regia')=true
// ──────────────────────────────────────────────────────────────────────────────
export function guestClaims(sub) {
  return { sub };
}
export function cassaClaims(sub = randUuid()) {
  return { sub, app_metadata: { role: 'cassa' } };
}
export function regiaClaims(sub = randUuid()) {
  return { sub, app_metadata: { role: 'regia' } };
}

// SETUP dati condiviso: una connessione SUPERUSER (owner del DB, fuori da role
// authenticated) crea UN evento 'TEST' in fase APERTA + un drink normale visibile
// + un drink premium nascosto (visibile=false). COMMIT: visibile a tutte le tx dei
// test. Idempotente: se l'evento 'TEST' esiste già lo riusa (riesecuzioni locali).
//
// I drink servono ai test RLS (drink visibile vs nascosto). La fase si cambia DENTRO
// la tx del singolo test via set_phase (claims regia) e il rollback la ripristina —
// MAI un UPDATE diretto su events da role authenticated (negato dalla RLS).
let _setupCache = null;
export async function setup() {
  if (_setupCache) return _setupCache;

  const c = await pool.connect();
  try {
    // Ci assicuriamo di NON essere su role authenticated qui: deve girare da owner.
    await c.query('reset role');

    let eventId;
    const existing = await c.query(
      "select id from public.events where nome = 'TEST' limit 1"
    );
    if (existing.rowCount > 0) {
      eventId = existing.rows[0].id;
      // riallinea la fase ad APERTA (riesecuzioni locali potrebbero averla mossa)
      await c.query("update public.events set fase = 'APERTA' where id = $1", [eventId]);
    } else {
      const ev = await c.query(
        "insert into public.events (nome, fase) values ('TEST', 'APERTA') returning id"
      );
      eventId = ev.rows[0].id;
    }

    // drink normale visibile
    let dn = await c.query(
      "select id from public.drinks where event_id = $1 and tipo = 'normale' and visibile = true limit 1",
      [eventId]
    );
    if (dn.rowCount === 0) {
      dn = await c.query(
        "insert into public.drinks (event_id, nome, tipo, visibile, attivo) values ($1, 'Birra TEST', 'normale', true, true) returning id",
        [eventId]
      );
    }

    // drink premium NASCOSTO (visibile=false) — per i test RLS drinks
    let dp = await c.query(
      "select id from public.drinks where event_id = $1 and tipo = 'premium' and visibile = false limit 1",
      [eventId]
    );
    if (dp.rowCount === 0) {
      dp = await c.query(
        "insert into public.drinks (event_id, nome, tipo, visibile, attivo) values ($1, 'Cocktail TEST nascosto', 'premium', false, true) returning id",
        [eventId]
      );
    }

    _setupCache = {
      eventId,
      drinkNormale: dn.rows[0].id,
      drinkPremium: dp.rows[0].id,
    };
    return _setupCache;
  } finally {
    c.release();
  }
}

// actAs(claims, fn): apre una tx, assume role authenticated, imposta i claims come
// SET LOCAL (validi solo nella tx), esegue fn(client) e fa SEMPRE rollback (anche
// in caso di errore) per lasciare il DB pulito tra un test e l'altro.
//
// NB: gli errori sollevati dalle RPC (raise exception '...') si propagano da fn e
// vengono catturati da assert.rejects nei test; il finally garantisce il rollback.
export async function actAs(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    return await fn(c);
  } finally {
    try {
      await c.query('rollback');
    } catch {
      /* rollback best-effort: la connessione viene comunque rilasciata */
    }
    c.release();
  }
}

// expectReject(client, sql, params, regex): esegue una query che DEVE fallire e
// verifica che il messaggio d'errore matchi `regex`. Avvolge la chiamata in un
// SAVEPOINT: quando un RPC fa `raise exception`, l'INTERA transazione passa in stato
// "aborted" (SQLSTATE 25P02) e ogni query successiva fallirebbe con "current
// transaction is aborted". Il rollback al savepoint ripristina la tx così il test può
// poi verificare lo stato del DB (es. "saldo invariato", "nessuna tx creata").
//
// Ritorna l'oggetto errore catturato (per asserzioni aggiuntive sul messaggio).
export async function expectReject(client, sql, params, regex) {
  const sp = 'sp_' + Math.random().toString(36).slice(2, 10);
  await client.query(`savepoint ${sp}`);
  let caught = null;
  try {
    await client.query(sql, params);
  } catch (err) {
    caught = err;
  } finally {
    // rollback al savepoint: ripulisce lo stato "aborted" lasciando viva la tx esterna
    await client.query(`rollback to savepoint ${sp}`);
    await client.query(`release savepoint ${sp}`);
  }
  if (caught == null) {
    throw new Error(`expected query to reject matching ${regex}, but it succeeded: ${sql}`);
  }
  if (!regex.test(caught.message)) {
    throw new Error(
      `expected reject matching ${regex}, got: ${caught.message}`
    );
  }
  return caught;
}

// Chiusura pulita del pool a fine suite (evita che node:test resti appeso).
export async function closePool() {
  await pool.end();
}
