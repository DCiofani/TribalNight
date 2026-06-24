// tests/e2e_supabase.test.mjs
// -----------------------------------------------------------------------------
// E2E REALE contro uno stack Supabase LOCALE (supabase start).
// Esercita il flusso server-authoritative completo dello schema v0.2:
//   anon sign-in ospite -> register_guest -> staff (cassa) topup -> RLS read ospite.
//
// Tutte le scritture passano dagli RPC SECURITY DEFINER; il front-end (e questo
// test) NON ricalcola mai i saldi: li rilegge da `guests` via RLS — lo stesso
// path che alimenta il realtime guest:state.
//
// Variabili d'ambiente richieste (output di `supabase status`):
//   SUPABASE_URL              es. http://127.0.0.1:54321
//   SUPABASE_ANON_KEY         anon key
//   SUPABASE_SERVICE_ROLE_KEY service_role key (Admin API)
//
// Se mancano: SKIP con messaggio chiaro (non fallisce la suite).
//
// Precondizione dello stack: schema v0.2 applicato + un evento seed in fase
// 'APERTA' (current_event() lo deve risolvere). Esempio seed:
//   insert into public.events (nome, fase) values ('Totem Night — E2E', 'APERTA');
//
// Esecuzione:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --test tests/e2e_supabase.test.mjs
// -----------------------------------------------------------------------------

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SKIP =
  !URL || !ANON_KEY || !SERVICE_ROLE_KEY
    ? 'SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY non impostate — ' +
      'avvia lo stack locale (`supabase start`) ed esporta le chiavi da `supabase status`. ' +
      'Test E2E saltato (non è un fallimento).'
    : false;

// Suffisso casuale per email/password staff (no collisioni tra run).
const rand = () => randomBytes(6).toString('hex');

// Stato condiviso tra i test (creato in `before`, ripulito in `after`).
const ctx = {
  admin: null, // service_role client (Admin API)
  staffUserId: null, // id utente staff creato, per il cleanup
  staffEmail: null,
  staffPassword: null,
};

before(() => {
  if (SKIP) return;
  ctx.admin = createClient(URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
});

// Cleanup best-effort: cancella l'utente staff (l'ospite anonimo resta innocuo).
after(async () => {
  if (SKIP || !ctx.admin || !ctx.staffUserId) return;
  try {
    await ctx.admin.auth.admin.deleteUser(ctx.staffUserId);
  } catch {
    // best-effort: non far fallire la suite per il cleanup
  }
});

test('E2E: register_guest -> topup (cassa) -> ospite rilegge saldo via RLS', { skip: SKIP }, async () => {
  // ---------------------------------------------------------------------------
  // 1) ADMIN: crea un utente staff con claim app_metadata.role = 'cassa'.
  //    Il claim 'cassa' abilita is_staff() lato DB (richiesto da topup()).
  // ---------------------------------------------------------------------------
  ctx.staffEmail = `cassa-${rand()}@test.local`;
  ctx.staffPassword = `pw-${rand()}`;

  const { data: created, error: createErr } = await ctx.admin.auth.admin.createUser({
    email: ctx.staffEmail,
    password: ctx.staffPassword,
    email_confirm: true,
    app_metadata: { role: 'cassa' },
  });
  assert.equal(createErr, null, `createUser fallita: ${createErr?.message ?? ''}`);
  assert.ok(created?.user?.id, 'createUser non ha restituito un user.id');
  ctx.staffUserId = created.user.id;

  // ---------------------------------------------------------------------------
  // 2) OSPITE: anonymous sign-in, risolve l'evento corrente, register_guest.
  // ---------------------------------------------------------------------------
  const ospite = createClient(URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: anon, error: anonErr } = await ospite.auth.signInAnonymously();
  assert.equal(anonErr, null, `signInAnonymously fallita: ${anonErr?.message ?? ''}`);
  assert.ok(anon?.user?.id, 'anonymous sign-in senza user.id');

  const { data: eventId, error: evErr } = await ospite.rpc('current_event');
  assert.equal(evErr, null, `current_event fallita: ${evErr?.message ?? ''}`);
  assert.ok(
    eventId,
    'current_event() ha restituito null — lo stack locale deve avere un evento seed ' +
      "in fase 'APERTA'. Esegui: insert into public.events (nome, fase) " +
      "values ('Totem Night — E2E', 'APERTA');",
  );

  const { data: guest, error: regErr } = await ospite.rpc('register_guest', {
    p_event: eventId,
    p_nome: 'E2E',
  });
  assert.equal(regErr, null, `register_guest fallita: ${regErr?.message ?? ''}`);
  assert.ok(guest?.id, 'register_guest non ha restituito guest.id');
  assert.equal(guest.event_id, eventId, 'guest.event_id non coincide con current_event()');
  assert.equal(guest.nome, 'E2E', 'guest.nome non valorizzato');
  // Ospite appena registrato: saldi e ticket a zero.
  assert.equal(guest.saldo_normale, 0, 'saldo_normale iniziale deve essere 0');
  assert.equal(guest.saldo_premium, 0, 'saldo_premium iniziale deve essere 0');
  assert.equal(guest.ticket_totali, 0, 'ticket_totali iniziale deve essere 0');

  // ---------------------------------------------------------------------------
  // 3) CASSA: sign-in con email/password staff, esegue topup via RPC.
  //    +2 consumazioni 'normale' per 10 euro. tipo della tx => 'ricarica'.
  // ---------------------------------------------------------------------------
  const cassa = createClient(URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: loginErr } = await cassa.auth.signInWithPassword({
    email: ctx.staffEmail,
    password: ctx.staffPassword,
  });
  assert.equal(loginErr, null, `signInWithPassword (cassa) fallita: ${loginErr?.message ?? ''}`);

  const idem = randomUUID();
  const { data: tx, error: topupErr } = await cassa.rpc('topup', {
    p_guest: guest.id,
    p_tipo: 'normale',
    p_qta: 2,
    p_importo: 10,
    p_idem: idem,
  });
  assert.equal(topupErr, null, `topup fallita: ${topupErr?.message ?? ''}`);
  assert.ok(tx, 'topup non ha restituito una transaction');
  assert.equal(tx.tipo, 'ricarica', "tx.tipo della topup deve essere 'ricarica'");
  assert.equal(tx.tipo_consumazione, 'normale', "tx.tipo_consumazione deve essere 'normale'");
  assert.equal(tx.qta_delta, 2, 'tx.qta_delta deve essere 2');
  assert.equal(tx.guest_id, guest.id, 'tx.guest_id deve riferire il guest');

  // ---------------------------------------------------------------------------
  // 4) OSPITE: rilegge la PROPRIA riga via RLS (path del realtime guest:state).
  //    L'ospite NON ricalcola: legge il saldo aggiornato dal DB.
  // ---------------------------------------------------------------------------
  const { data: g2, error: readErr } = await ospite
    .from('guests')
    .select('saldo_normale, saldo_premium, ticket_totali')
    .eq('id', guest.id)
    .single();
  assert.equal(readErr, null, `rilettura guest (RLS) fallita: ${readErr?.message ?? ''}`);
  assert.ok(g2, "l'ospite non ha potuto rileggere la propria riga (RLS?)");
  assert.equal(g2.saldo_normale, 2, 'saldo_normale dopo topup deve essere 2');
  assert.equal(g2.saldo_premium, 0, 'saldo_premium non deve cambiare (resta 0)');

  // ---------------------------------------------------------------------------
  // 5) IDEMPOTENZA: ritentare topup con LO STESSO p_idem (retry di rete) NON
  //    deve raddoppiare il saldo: la RPC ritorna la transazione già scritta.
  // ---------------------------------------------------------------------------
  const { data: txRetry, error: retryErr } = await cassa.rpc('topup', {
    p_guest: guest.id,
    p_tipo: 'normale',
    p_qta: 2,
    p_importo: 10,
    p_idem: idem, // stesso idem della prima topup
  });
  assert.equal(retryErr, null, `topup retry fallita: ${retryErr?.message ?? ''}`);
  assert.equal(txRetry.id, tx.id, 'il retry deve ritornare la STESSA transaction (idempotenza)');

  const { data: g3 } = await ospite
    .from('guests')
    .select('saldo_normale')
    .eq('id', guest.id)
    .single();
  assert.equal(g3.saldo_normale, 2, 'saldo_normale dopo retry idempotente deve restare 2 (non 4)');

  // Teardown sessioni client (best-effort; le sessioni non sono persistite).
  await ospite.auth.signOut().catch(() => {});
  await cassa.auth.signOut().catch(() => {});
});
