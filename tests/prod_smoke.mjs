// tests/prod_smoke.mjs — SMOKE e2e contro un deploy LIVE (Postgres + Next + auth propria).
//
// Non è un unit test: colpisce un ambiente reale e CREA un guest usa-e-getta sull'evento
// corrente. Va lanciato a mano per il soak/post-deploy, MAI in CI (skip se manca STAFF_PW).
//
//   STAFF_PW='...' node tests/prod_smoke.mjs
//   BASE=https://web-production-2df81.up.railway.app STAFF_EMAIL=cassa@totem.local \
//     STAFF_PW='...' node tests/prod_smoke.mjs
//
// Copre l'intero contratto del backend nuovo senza wrapper Supabase:
//   anon · current_event · register · RLS self-read · staff login(role) · lookup PIN ·
//   topup · saldo aggiornato · negativo(ospite!=topup) · SSE realtime ·
//   consume(path+input-validation) · RBAC(draw vietato a ospite/cassa) · phase-guard(convert).
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'https://web-production-2df81.up.railway.app';
const STAFF_EMAIL = process.env.STAFF_EMAIL ?? 'cassa@totem.local';
const REGIA_EMAIL = process.env.REGIA_EMAIL ?? 'regia@totem.local';
const REGIA_PW = process.env.REGIA_PW; // opt-in: abilita i check M2/M3 (regia/drink/stats/stream/consumo)
const STAFF_PW = process.env.STAFF_PW;
if (!STAFF_PW) {
  console.log('SKIP prod_smoke: STAFF_PW non impostata (smoke su ambiente live, opt-in).');
  process.exit(0);
}

const H = (cookie) => ({ origin: BASE, accept: 'application/json', ...(cookie ? { cookie } : {}) });
const jget = (r) => r.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ') || '';
let pass = 0;
const ok = (m) => { console.log('  ✓', m); pass++; };

// 1) OSPITE: anon
let r = await fetch(BASE + '/api/auth/anon', { method: 'POST', headers: H() });
assert.equal(r.status, 200, 'anon 200'); const gc = jget(r); assert.ok(gc, 'cookie ospite'); ok('anon sign-in');

// 2) current_event
r = await fetch(BASE + '/api/event/current', { headers: H(gc) });
assert.equal(r.status, 200); const ev = (await r.json()).event_id; assert.ok(ev, 'event_id'); ok('current_event ' + ev.slice(0, 8));

// 3) register
r = await fetch(BASE + '/api/guest/register', { method: 'POST', headers: { ...H(gc), 'content-type': 'application/json' }, body: JSON.stringify({ p_event: ev, p_nome: 'Soak Test' }) });
assert.equal(r.status, 200); const guest = await r.json();
assert.ok(guest.id && guest.pin, 'guest creato'); assert.equal(guest.saldo_normale, 0); assert.equal(guest.nome, 'Soak Test');
assert.ok(guest.auth_uid, 'auth_uid legato'); ok('register guest pin=' + guest.pin + ' saldo0');

// 4) ospite read self (RLS)
r = await fetch(BASE + '/api/guest/' + guest.id, { headers: H(gc) });
assert.equal(r.status, 200); const self = await r.json(); assert.equal(self.id, guest.id); ok('ospite legge sé (RLS)');

// 5) STAFF login
r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { ...H(), 'content-type': 'application/json' }, body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PW }) });
assert.equal(r.status, 200, 'login staff 200'); const sc = jget(r);
const me = await (await fetch(BASE + '/api/auth/me', { headers: H(sc) })).json();
assert.ok(['cassa', 'regia', 'admin'].includes(me.role), 'ruolo staff'); ok('staff login role=' + me.role);

// 6) lookup per PIN (staff)
r = await fetch(BASE + '/api/cassa/guest?pin=' + guest.pin, { headers: H(sc) });
assert.equal(r.status, 200); const look = await r.json(); assert.equal(look.id, guest.id, 'lookup trova il guest'); ok('lookup per PIN');

// 7) topup (staff)
r = await fetch(BASE + '/api/cassa/topup', { method: 'POST', headers: { ...H(sc), 'content-type': 'application/json' }, body: JSON.stringify({ p_guest: guest.id, p_tipo: 'normale', p_qta: 3, p_importo: 15 }) });
assert.equal(r.status, 200, 'topup 200'); ok('topup +3 normale');

// 8) ospite rilegge saldo aggiornato (RLS)
r = await fetch(BASE + '/api/guest/' + guest.id, { headers: H(gc) });
const g2 = await r.json(); assert.equal(g2.saldo_normale, 3, 'saldo_normale=3'); ok('ospite vede saldo 3');

// 9) NEGATIVO: ospite prova topup → vietato
r = await fetch(BASE + '/api/cassa/topup', { method: 'POST', headers: { ...H(gc), 'content-type': 'application/json' }, body: JSON.stringify({ p_guest: guest.id, p_tipo: 'normale', p_qta: 99, p_importo: 0 }) });
assert.ok([401, 403, 400].includes(r.status), 'ospite NON puo topup (' + r.status + ')'); ok('negativo: ospite non topup (' + r.status + ')');

// 10) SSE: apri stream, topup, attendi evento
const ac = new AbortController(); let sseBuf = '';
const sse = (async () => { const s = await fetch(BASE + '/api/stream/guest?guest=' + guest.id, { headers: { ...H(gc), accept: 'text/event-stream' }, signal: ac.signal }); for await (const ch of s.body) { sseBuf += Buffer.from(ch).toString(); } return sseBuf; })().catch(() => sseBuf);
await new Promise((x) => setTimeout(x, 800));
await fetch(BASE + '/api/cassa/topup', { method: 'POST', headers: { ...H(sc), 'content-type': 'application/json' }, body: JSON.stringify({ p_guest: guest.id, p_tipo: 'premium', p_qta: 1, p_importo: 8 }) });
await new Promise((x) => setTimeout(x, 3000)); ac.abort(); await sse;
assert.ok(/(event:|data:)/.test(sseBuf), 'SSE evento ricevuto'); ok('SSE realtime: evento dopo topup');

// 11) consume (cassa) con drink uuid inesistente → route+auth OK, DB rifiuta (400, nessuna mutazione)
r = await fetch(BASE + '/api/cassa/consume', { method: 'POST', headers: { ...H(sc), 'content-type': 'application/json' }, body: JSON.stringify({ p_guest: guest.id, p_drink: '00000000-0000-0000-0000-000000000000' }) });
assert.equal(r.status, 400, 'consume drink inesistente → 400 (' + r.status + ')'); ok('consume: path OK, drink invalido respinto (400)');

// 12) RBAC: ospite NON puo estrarre (regia/admin)
r = await fetch(BASE + '/api/regia/draw', { method: 'POST', headers: { ...H(gc), 'content-type': 'application/json' }, body: JSON.stringify({ p_event: ev, p_n_winners: 1 }) });
assert.ok([401, 403].includes(r.status), 'ospite→draw vietato (' + r.status + ')'); ok('RBAC: ospite non estrae (' + r.status + ')');

// 13) RBAC: cassa NON e regia → draw vietato
r = await fetch(BASE + '/api/regia/draw', { method: 'POST', headers: { ...H(sc), 'content-type': 'application/json' }, body: JSON.stringify({ p_event: ev, p_n_winners: 1 }) });
assert.ok([401, 403].includes(r.status), 'cassa→draw vietato (' + r.status + ')'); ok('RBAC: cassa non estrae (' + r.status + ')');

// 14) convert_credit dell'ospite (su sé): route raggiungibile + auth; phase-guard nel DB (APERTA→400, oppure eseguito)
r = await fetch(BASE + '/api/credit/convert', { method: 'POST', headers: { ...H(gc), 'content-type': 'application/json' }, body: JSON.stringify({ p_guest: guest.id }) });
assert.ok([200, 400].includes(r.status), 'convert raggiungibile (' + r.status + ')'); ok('convert: route+auth OK (' + r.status + (r.status === 400 ? ', phase-guard' : ', eseguito') + ')');

// ── M2/M3 (opt-in REGIA_PW): regia + lista drink + stats + consumo reale ──────────────
// NON muta la FASE evento (niente set_phase/run_draw su live); tocca solo il guest usa-e-getta.
if (REGIA_PW) {
  const ct = (c) => ({ ...H(c), 'content-type': 'application/json' });

  r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: ct(), body: JSON.stringify({ email: REGIA_EMAIL, password: REGIA_PW }) });
  assert.equal(r.status, 200, 'login regia 200'); const rc = jget(r);
  const meR = await fetch(BASE + '/api/auth/me', { headers: H(rc) }).then((x) => x.json());
  assert.equal(meR.role, 'regia', 'role regia'); ok('M2/M3: login regia');

  r = await fetch(BASE + '/api/regia/drink?event=' + ev, { headers: H(sc) });
  assert.equal(r.status, 200, 'drink 200'); const drinks = await r.json();
  assert.ok(Array.isArray(drinks) && drinks.length >= 1, 'almeno 1 drink'); ok('M2/M3: GET drink (cassa) → ' + drinks.length);

  r = await fetch(BASE + '/api/regia/drink?event=' + ev, { headers: H(gc) });
  assert.ok([401, 403].includes(r.status), 'ospite no drink'); ok('M2/M3: RBAC ospite no drink (' + r.status + ')');

  r = await fetch(BASE + '/api/regia/stats?event=' + ev, { headers: H(rc) });
  assert.equal(r.status, 200, 'stats 200'); const stt = await r.json();
  assert.equal(typeof stt.presenze, 'number', 'presenze number');
  assert.equal(typeof stt.gettoni_venduti, 'number', 'gettoni number (fix int, no string)');
  assert.equal(typeof stt.ticket_totali, 'number', 'ticket number (fix int, no string)');
  ok('M2/M3: GET stats (regia) numeri reali fase=' + stt.fase);

  r = await fetch(BASE + '/api/regia/stats?event=' + ev, { headers: H(sc) });
  assert.ok([401, 403].includes(r.status), 'cassa no stats'); ok('M2/M3: RBAC cassa no stats (' + r.status + ')');

  r = await fetch(BASE + '/api/stream/regia?event=' + ev, { headers: H(sc) });
  if (r.body) await r.body.cancel();
  assert.ok([401, 403].includes(r.status), 'cassa no stream'); ok('M2/M3: RBAC cassa no stream (' + r.status + ')');
  {
    const ac = new AbortController();
    const sr = await fetch(BASE + '/api/stream/regia?event=' + ev, { headers: { ...H(rc), accept: 'text/event-stream' }, signal: ac.signal });
    assert.equal(sr.status, 200, 'stream regia 200'); ac.abort(); ok('M2/M3: stream regia apre SSE 200');
  }

  // consumo reale sul guest usa-e-getta (riusa `guest`); drink[0]; delta-based.
  const d0 = drinks[0]; const sk = d0.tipo === 'premium' ? 'saldo_premium' : 'saldo_normale';
  await fetch(BASE + '/api/cassa/topup', { method: 'POST', headers: ct(sc), body: JSON.stringify({ p_guest: guest.id, p_tipo: d0.tipo, p_qta: 1, p_importo: 0 }) });
  const b = await fetch(BASE + '/api/guest/' + guest.id, { headers: H(gc) }).then((x) => x.json());
  r = await fetch(BASE + '/api/cassa/consume', { method: 'POST', headers: ct(sc), body: JSON.stringify({ p_guest: guest.id, p_drink: d0.id }) });
  assert.equal(r.status, 200, 'consume 200 (' + r.status + ')');
  const a = await fetch(BASE + '/api/guest/' + guest.id, { headers: H(gc) }).then((x) => x.json());
  assert.equal(a[sk], b[sk] - 1, sk + ' -1 dopo consumo');
  assert.ok((a.ticket_totali ?? 0) > (b.ticket_totali ?? 0), 'ticket aumentati');
  ok('M2/M3: consumo reale ' + d0.nome + ' (' + d0.tipo + ') → ' + sk + ' ' + b[sk] + '→' + a[sk] + ', ticket ' + (b.ticket_totali ?? 0) + '→' + (a.ticket_totali ?? 0));
} else {
  console.log('  · M2/M3 skip (REGIA_PW non impostata)');
}

console.log('\nRISULTATO: ' + pass + ' PASS — ' + BASE + ' (Postgres + Next + auth propria)');
