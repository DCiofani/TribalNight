// tests/api_http.test.mjs
// -----------------------------------------------------------------------------
// TEST DI INTEGRAZIONE HTTP REALE contro un server Next.js IN ESECUZIONE.
//
// Non parla col DB direttamente: esercita SOLO l'HTTP edge (le API routes della
// Fase 2 — RPC + read-through come Next.js routes). È il complemento dei contract
// test (tests/db.mjs + rls/topup/register_guest) che invece bypassano l'HTTP.
//
// Env-gated (niente server → niente test, skip pulito):
//   BASE_URL          es. http://localhost:3030  → URL del Next in esecuzione.
//                     ASSENTE ⇒ tutta la suite è SKIP (non un fallimento).
//   STAFF_EMAIL       email di uno staff seedato in auth.staff_users (ruolo cassa/admin).
//   STAFF_PW          password in chiaro di quello staff.
//                     ASSENTI ⇒ la parte "cassa" (login/topup/negativo) è SKIP;
//                     il flusso ospite (anon→event→register→read) gira comunque.
//
// AUTH_DB_URL/DATABASE_URL NON servono qui: si parla via HTTP, è il server che ha il DB.
//
// PRECONDIZIONE lato server: schema applicato + un evento in fase 'APERTA'
// (current_event() lo deve risolvere; topup richiede fase APERTA). Lo staff
// STAFF_EMAIL/STAFF_PW deve esistere (il seed NON è creabile via HTTP: niente
// endpoint di signup staff — è una scelta di sicurezza).
//
// Flusso:
//   (1) POST /api/auth/anon                 → cookie tn_at (ospite)
//   (2) GET  /api/event/current             → eventId
//   (3) POST /api/guest/register            → guest { id, pin, saldo_* }
//   (4) login staff (se STAFF_* presenti)   → cookie tn_at staff   [SKIP altrimenti]
//   (5) POST /api/cassa/topup               → transaction (ricarica premium)
//   (6) GET  /api/guest/[id] (come OSPITE)  → saldo_premium aggiornato (DB authoritative)
//   (7) NEGATIVO: ospite → POST /api/cassa/topup → 401/403/400 (gate staff)
//
// Esecuzione:
//   BASE_URL=http://localhost:3030 \
//   STAFF_EMAIL=cassa@example.com STAFF_PW=secret \
//     node --test tests/api_http.test.mjs
// -----------------------------------------------------------------------------

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.BASE_URL?.replace(/\/+$/, '') ?? '';
const STAFF_EMAIL = process.env.STAFF_EMAIL ?? '';
const STAFF_PW = process.env.STAFF_PW ?? '';

const HAS_SERVER = BASE_URL.length > 0;
const HAS_STAFF = HAS_SERVER && STAFF_EMAIL.length > 0 && STAFF_PW.length > 0;

// ── Cookie jar manuale ────────────────────────────────────────────────────────
// Un jar = una "sessione browser". Legge Set-Cookie dalle risposte, conserva
// name=value (ignora gli attributi Path/HttpOnly/Secure/SameSite/Expires) e li
// rimanda nell'header Cookie delle richieste successive. Sufficiente per testare
// il giro cookie HttpOnly delle route auth (fetch non li espone a document.cookie,
// ma Set-Cookie è leggibile lato Node).
function makeJar() {
  const store = new Map(); // name -> value
  return {
    /** Estrae i cookie da una Response e li salva nel jar. */
    capture(res) {
      // getSetCookie() (Node ≥18.14) ritorna l'array completo, una entry per cookie:
      // fondamentale perché un singolo header 'set-cookie' concatenato spezzerebbe
      // sui ';' interni alle date Expires. Fallback al singolo header se assente.
      const raw =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
      for (const line of raw) {
        const first = line.split(';', 1)[0]; // "name=value"
        const eq = first.indexOf('=');
        if (eq === -1) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (!name) continue;
        // Un valore vuoto (logout) rimuove il cookie dal jar.
        if (value === '') store.delete(name);
        else store.set(name, value);
      }
    },
    /** Header Cookie da inviare, o '' se il jar è vuoto. */
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    has(name) {
      return store.has(name);
    },
  };
}

/**
 * api(jar, method, path, body?): fetch verso BASE_URL+path con:
 *   - Cookie del jar (sessione);
 *   - Origin = BASE_URL (passa il check sameOriginOk delle mutazioni: per i client
 *     non-browser come questo test, Origin same-origin è la via legittima);
 *   - body JSON se fornito.
 * Cattura sempre i Set-Cookie nel jar. Ritorna { res, json } (json=null se non-JSON).
 */
async function api(jar, method, path, body) {
  const headers = { origin: BASE_URL };
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  let init = { method, headers, redirect: 'manual' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  jar.capture(res);
  let json = null;
  try {
    json = await res.clone().json();
  } catch {
    json = null;
  }
  return { res, json };
}

// Skip dell'intera suite se non c'è un server contro cui parlare.
before(() => {
  if (!HAS_SERVER) {
    // node:test non ha un "skip all" globale: lo facciamo segnalando nei singoli test.
    // Stampa una riga diagnostica una sola volta.
    console.log('[api_http] BASE_URL assente → suite SKIP (nessun server Next).');
  }
});

// ── (1)-(3)-(6) Flusso OSPITE (sempre, se c'è il server) ────────────────────────
test('flusso ospite: anon → event → register → read self', { skip: !HAS_SERVER && 'BASE_URL assente' }, async (t) => {
  const guest = makeJar();

  // (1) anon → cookie access (tn_at). Body { sub }.
  const anon = await api(guest, 'POST', '/api/auth/anon');
  assert.equal(anon.res.status, 200, `anon status ${anon.res.status}`);
  assert.ok(guest.has('tn_at'), 'anon deve settare il cookie tn_at');
  assert.ok(anon.json && typeof anon.json.sub === 'string', 'anon ritorna { sub }');

  // (2) current event.
  const ev = await api(guest, 'GET', '/api/event/current');
  assert.equal(ev.res.status, 200, `event/current status ${ev.res.status}`);
  const eventId = ev.json?.event_id;
  assert.ok(eventId, 'deve esistere un evento attivo (precondizione: 1 evento APERTA)');

  // (3) register guest. Idempotente: la RPC ritorna la riga esistente al retry.
  const reg = await api(guest, 'POST', '/api/guest/register', {
    p_event: eventId,
    p_nome: 'Ospite HTTP Test',
  });
  assert.equal(reg.res.status, 200, `register status ${reg.res.status} body=${JSON.stringify(reg.json)}`);
  assert.ok(reg.json && typeof reg.json.id === 'string', 'register ritorna la riga guest con id');
  assert.equal(reg.json.event_id, eventId, 'guest.event_id == eventId');
  assert.ok(typeof reg.json.pin === 'string' && reg.json.pin.length >= 4, 'guest ha un pin');
  const guestId = reg.json.id;
  const saldoPremiumIniziale = Number(reg.json.saldo_premium ?? 0);

  // condivide lo stato col blocco cassa via context del test runner.
  t.diagnostic(`guestId=${guestId} pin=${reg.json.pin} saldo_premium0=${saldoPremiumIniziale}`);

  // (6-pre) l'ospite legge la PROPRIA riga (RLS self) → ok.
  const self = await api(guest, 'GET', `/api/guest/${guestId}`);
  assert.equal(self.res.status, 200, `guest/[id] self status ${self.res.status}`);
  assert.equal(self.json?.id, guestId, 'ospite legge la propria riga');

  // ── (4)-(5)-(6)-(7) parte CASSA (solo se STAFF_* presenti) ───────────────────
  await t.test('cassa: login → topup → ospite vede saldo → negativo', { skip: !HAS_STAFF && 'STAFF_EMAIL/STAFF_PW assenti' }, async () => {
    const staff = makeJar();

    // (4) login staff → cookie tn_at staff, body { role }.
    const login = await api(staff, 'POST', '/api/auth/login', {
      email: STAFF_EMAIL,
      password: STAFF_PW,
    });
    assert.equal(login.res.status, 200, `login status ${login.res.status} body=${JSON.stringify(login.json)}`);
    assert.ok(staff.has('tn_at'), 'login deve settare tn_at');
    assert.ok(
      ['cassa', 'regia', 'admin'].includes(login.json?.role),
      `login ritorna un ruolo staff (ha: ${login.json?.role})`,
    );

    // (5) topup premium +3 (idempotency key fornita dal client).
    const idem = randomUUID();
    const qta = 3;
    const topup = await api(staff, 'POST', '/api/cassa/topup', {
      p_guest: guestId,
      p_tipo: 'premium',
      p_qta: qta,
      p_importo: 24,
      p_idem: idem,
    });
    assert.equal(topup.res.status, 200, `topup status ${topup.res.status} body=${JSON.stringify(topup.json)}`);
    assert.equal(topup.json?.tipo, 'ricarica', 'la transaction è una ricarica');
    assert.equal(topup.json?.guest_id, guestId, 'transaction.guest_id == guestId');
    assert.equal(topup.json?.id, idem, 'transaction.id == idempotency key fornita');

    // (5-bis) idempotenza: stesso idem → stessa transaction, nessun doppio accredito.
    const topupRetry = await api(staff, 'POST', '/api/cassa/topup', {
      p_guest: guestId,
      p_tipo: 'premium',
      p_qta: qta,
      p_importo: 24,
      p_idem: idem,
    });
    assert.equal(topupRetry.res.status, 200, 'topup retry idempotente status 200');
    assert.equal(topupRetry.json?.id, idem, 'topup retry ritorna la stessa transaction');

    // (6) l'OSPITE (jar guest) rilegge la propria riga → saldo_premium aggiornato.
    //     Il DB è authoritative: nessun ricalcolo lato client.
    const after = await api(guest, 'GET', `/api/guest/${guestId}`);
    assert.equal(after.res.status, 200, `guest/[id] post-topup status ${after.res.status}`);
    assert.equal(
      Number(after.json?.saldo_premium),
      saldoPremiumIniziale + qta,
      'saldo_premium = iniziale + qta (un solo accredito nonostante il retry)',
    );

    // (7) NEGATIVO: l'OSPITE (non staff) prova a chiamare topup → rifiutato.
    //     Il gate requireRole risponde 401/403; anche se lo bypassasse, la RPC
    //     fa `if not is_staff() then raise` → 400. Accettiamo tutti questi.
    const guestTopup = await api(guest, 'POST', '/api/cassa/topup', {
      p_guest: guestId,
      p_tipo: 'premium',
      p_qta: 1,
      p_importo: 8,
      p_idem: randomUUID(),
    });
    assert.ok(
      [400, 401, 403].includes(guestTopup.res.status),
      `ospite su /api/cassa/topup deve essere rifiutato (status ${guestTopup.res.status})`,
    );

    // E il saldo NON deve essere cambiato dal tentativo dell'ospite.
    const stillSame = await api(guest, 'GET', `/api/guest/${guestId}`);
    assert.equal(
      Number(stillSame.json?.saldo_premium),
      saldoPremiumIniziale + qta,
      'il tentativo non-autorizzato non ha modificato il saldo',
    );
  });
});
