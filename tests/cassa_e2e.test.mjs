// tests/cassa_e2e.test.mjs
// -----------------------------------------------------------------------------
// E2E REALE della SCHERMATA CASSA contro uno stack Supabase LOCALE.
// Esercita il path esatto che la pagina app/cassa/page.tsx userà una volta cablata:
//
//   1) admin (service_role) crea utente staff con app_metadata.role = 'cassa'
//   2) ospite anon -> current_event() -> register_guest('PinTest')  (ottiene id + pin)
//   3) cassa: signInWithPassword -> getUser().app_metadata.role === 'cassa'
//   4) cassa LOOKUP per PIN: SELECT diretta su guests (RLS staff is_staff) -> trova l'ospite
//   5) cassa topup('premium', 3, 24, idem) via RPC SECURITY DEFINER -> tx ok
//   6) cassa ri-legge il guest by id -> saldo_premium === 3 (DB authoritative, no ricalcolo)
//   7) NEGATIVE: un secondo ospite anon (NON staff) prova lo stesso lookup per PIN
//      -> 0 righe, la RLS guests_select lo nasconde (vede solo la PROPRIA riga)
//   8) cleanup: admin.deleteUser dello staff
//
// VINCOLO ARCHITETTURALE verificato: il front-end NON ricalcola saldi/ticket.
// Scrive SOLO via RPC (topup); legge i saldi rileggendo `guests` via RLS.
// Il lookup per PIN della cassa è una SELECT diretta (non RPC): consentita allo
// staff dalla policy guests_select (is_staff), negata agli altri ospiti.
//
// Variabili d'ambiente richieste (output di `supabase status`):
//   SUPABASE_URL              es. http://127.0.0.1:54321
//   SUPABASE_ANON_KEY         anon key
//   SUPABASE_SERVICE_ROLE_KEY service_role key (Admin API)
//
// Se mancano: SKIP pulito (non è un fallimento della suite).
//
// Precondizione dello stack: schema v0.2 applicato + un evento seed in fase
// 'APERTA' (current_event() lo deve risolvere). Esempio seed:
//   insert into public.events (nome, fase) values ('Totem Night — E2E', 'APERTA');
//
// Esecuzione:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --test tests/cassa_e2e.test.mjs
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

// Factory client: sessioni mai persistite, nessun refresh in background.
const makeClient = (key) =>
  createClient(URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

// Stato condiviso tra setup/test/cleanup.
const ctx = {
  admin: null, // service_role client (Admin API)
  staffUserId: null, // id utente staff creato, per il cleanup
  staffEmail: null,
  staffPassword: null,
};

before(() => {
  if (SKIP) return;
  ctx.admin = makeClient(SERVICE_ROLE_KEY);
});

// Cleanup best-effort: cancella l'utente staff (gli ospiti anonimi restano innocui).
after(async () => {
  if (SKIP || !ctx.admin || !ctx.staffUserId) return;
  try {
    await ctx.admin.auth.admin.deleteUser(ctx.staffUserId);
  } catch {
    // best-effort: non far fallire la suite per il cleanup
  }
});

test(
  'E2E cassa: lookup per PIN (RLS staff) -> topup premium -> rilettura saldo; ospite non-staff non vede il PIN altrui',
  { skip: SKIP },
  async () => {
    // -------------------------------------------------------------------------
    // 1) ADMIN: crea un utente staff con claim app_metadata.role = 'cassa'.
    //    Il claim 'cassa' abilita is_staff() lato DB (gating di topup + RLS lookup).
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // 2) OSPITE: anonymous sign-in -> current_event() -> register_guest('PinTest').
    //    Otteniamo id e pin: sono i due input del lookup di cassa.
    // -------------------------------------------------------------------------
    const ospite = makeClient(ANON_KEY);

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
      p_nome: 'PinTest',
    });
    assert.equal(regErr, null, `register_guest fallita: ${regErr?.message ?? ''}`);
    assert.ok(guest?.id, 'register_guest non ha restituito guest.id');
    assert.ok(guest?.pin, 'register_guest non ha restituito un PIN');
    assert.equal(guest.event_id, eventId, 'guest.event_id non coincide con current_event()');
    assert.equal(guest.nome, 'PinTest', 'guest.nome non valorizzato');
    // Ospite appena registrato: saldo premium a zero (lo verifichiamo dopo la topup).
    assert.equal(guest.saldo_premium, 0, 'saldo_premium iniziale deve essere 0');

    // -------------------------------------------------------------------------
    // 3) CASSA: sign-in email/password staff; verifica il ruolo dal claim.
    //    È il check che la pagina cassa usa per gating UI (app_metadata.role).
    // -------------------------------------------------------------------------
    const cassa = makeClient(ANON_KEY);

    const { error: loginErr } = await cassa.auth.signInWithPassword({
      email: ctx.staffEmail,
      password: ctx.staffPassword,
    });
    assert.equal(loginErr, null, `signInWithPassword (cassa) fallita: ${loginErr?.message ?? ''}`);

    const { data: userData, error: getUserErr } = await cassa.auth.getUser();
    assert.equal(getUserErr, null, `getUser (cassa) fallita: ${getUserErr?.message ?? ''}`);
    assert.equal(
      userData?.user?.app_metadata?.role,
      'cassa',
      "il claim app_metadata.role della sessione cassa deve essere 'cassa'",
    );

    // -------------------------------------------------------------------------
    // 4) CASSA LOOKUP PER PIN: SELECT DIRETTA (non RPC) su guests.
    //    Consentita allo staff dalla policy RLS guests_select (is_staff):
    //    la cassa risolve l'ospite a partire dal solo PIN digitato.
    // -------------------------------------------------------------------------
    const { data: found, error: lookupErr } = await cassa
      .from('guests')
      .select('id, nome, saldo_normale')
      .eq('event_id', eventId)
      .eq('pin', guest.pin)
      .maybeSingle();
    assert.equal(lookupErr, null, `lookup per PIN (cassa) fallito: ${lookupErr?.message ?? ''}`);
    assert.ok(found, "lookup per PIN: la cassa (staff) deve trovare l'ospite (RLS is_staff)");
    assert.equal(found.id, guest.id, 'il lookup per PIN deve risolvere lo stesso guest.id');
    assert.equal(found.nome, 'PinTest', 'il lookup per PIN deve restituire il nome corretto');

    // -------------------------------------------------------------------------
    // 5) CASSA TOPUP: +3 consumazioni 'premium' per 24 euro, via RPC.
    //    Unico path di scrittura del front-end. p_idem generato client.
    // -------------------------------------------------------------------------
    const idem = randomUUID();
    const { data: tx, error: topupErr } = await cassa.rpc('topup', {
      p_guest: guest.id,
      p_tipo: 'premium',
      p_qta: 3,
      p_importo: 24,
      p_idem: idem,
    });
    assert.equal(topupErr, null, `topup fallita: ${topupErr?.message ?? ''}`);
    assert.ok(tx, 'topup non ha restituito una transaction');
    assert.equal(tx.tipo, 'ricarica', "tx.tipo della topup deve essere 'ricarica'");
    assert.equal(tx.tipo_consumazione, 'premium', "tx.tipo_consumazione deve essere 'premium'");
    assert.equal(tx.qta_delta, 3, 'tx.qta_delta deve essere 3');
    assert.equal(Number(tx.importo_euro), 24, 'tx.importo_euro deve essere 24');
    assert.equal(tx.guest_id, guest.id, 'tx.guest_id deve riferire il guest');

    // -------------------------------------------------------------------------
    // 6) CASSA RI-LEGGE il guest by id: il saldo è quello del DB, NON ricalcolato.
    // -------------------------------------------------------------------------
    const { data: g2, error: readErr } = await cassa
      .from('guests')
      .select('saldo_normale, saldo_premium')
      .eq('id', guest.id)
      .single();
    assert.equal(readErr, null, `rilettura guest (cassa) fallita: ${readErr?.message ?? ''}`);
    assert.ok(g2, 'la cassa non ha potuto rileggere la riga guest');
    assert.equal(g2.saldo_premium, 3, 'saldo_premium dopo topup deve essere 3');
    assert.equal(g2.saldo_normale, 0, 'saldo_normale non deve cambiare (resta 0)');

    // -------------------------------------------------------------------------
    // 7) NEGATIVE: un SECONDO ospite anonimo (NON staff) prova lo stesso lookup
    //    per PIN del primo ospite. La policy guests_select gli mostra SOLO la
    //    propria riga: il filtro per il PIN altrui deve restituire 0 righe.
    // -------------------------------------------------------------------------
    const intruso = makeClient(ANON_KEY);
    const { error: intrusoSignInErr } = await intruso.auth.signInAnonymously();
    assert.equal(
      intrusoSignInErr,
      null,
      `signInAnonymously (intruso) fallita: ${intrusoSignInErr?.message ?? ''}`,
    );

    // L'intruso REGISTRA un proprio ospite: così ha una riga VISIBILE (la sua) e il
    // test di controllo qui sotto è significativo (RLS deve mostrargli la propria
    // riga ma NON quella della vittima), non vacuo per assenza di righe.
    const { data: intrusoGuest, error: intrusoRegErr } = await intruso.rpc(
      'register_guest',
      { p_event: eventId, p_nome: 'Intruso' },
    );
    assert.equal(
      intrusoRegErr,
      null,
      `register_guest (intruso) fallita: ${intrusoRegErr?.message ?? ''}`,
    );
    assert.ok(intrusoGuest?.id, 'register_guest (intruso) non ha restituito id');
    assert.notEqual(intrusoGuest.id, guest.id, 'intruso e vittima devono essere righe diverse');

    const { data: leaked, error: intrusoErr } = await intruso
      .from('guests')
      .select('id, nome, saldo_normale')
      .eq('event_id', eventId)
      .eq('pin', guest.pin)
      .maybeSingle();
    // RLS non genera errore: filtra le righe. maybeSingle() su 0 righe -> data null.
    // NB: se per caso il PIN dell'intruso collidesse con quello della vittima
    // l'assert sarebbe ambiguo — ma l'unique (event_id,pin) lo impedisce.
    assert.equal(intrusoErr, null, `lookup intruso ha dato errore inatteso: ${intrusoErr?.message ?? ''}`);
    assert.equal(
      leaked,
      null,
      'VIOLAZIONE RLS: un ospite non-staff è riuscito a risolvere il PIN di un altro ospite',
    );

    // Conferma di controllo (ora NON vacua): l'intruso vede la PROPRIA riga ma non
    // quella della vittima. Se RLS fosse rotta, vedrebbe entrambe.
    const { data: ownRows, error: ownErr } = await intruso
      .from('guests')
      .select('id')
      .eq('event_id', eventId);
    assert.equal(ownErr, null, `select self (intruso) fallita: ${ownErr?.message ?? ''}`);
    assert.ok(Array.isArray(ownRows), 'select self (intruso) non ha restituito un array');
    assert.ok(
      ownRows.some((r) => r.id === intrusoGuest.id),
      "l'intruso deve vedere la PROPRIA riga (RLS auth_uid = auth.uid())",
    );
    assert.ok(
      !ownRows.some((r) => r.id === guest.id),
      "l'intruso non deve poter vedere la riga di un altro ospite (RLS guests_select)",
    );

    // Teardown sessioni client (best-effort; non sono persistite).
    await ospite.auth.signOut().catch(() => {});
    await cassa.auth.signOut().catch(() => {});
    await intruso.auth.signOut().catch(() => {});
  },
);
