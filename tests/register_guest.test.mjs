// tests/register_guest.test.mjs — contratto REALE di public.register_guest (v0.2).
// Lo schema è la fonte di verità: questi test PROVANO il contratto, non lo riscrivono.
// Ogni test gira in una tx con rollback (vedi actAs). Asserzioni vere su stato DB e
// su messaggi d'errore (assert.rejects con match sul testo sollevato dalla RPC).

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, actAs, guestClaims, randUuid, closePool } from './db.mjs';

after(async () => {
  await closePool();
});

describe('register_guest', () => {
  test('happy_crea_guest — riga creata con tutti i default del contratto', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const before = Date.now();
      const r = await c.query('select * from register_guest($1, $2)', [eventId, 'Mario']);
      assert.equal(r.rowCount, 1, 'register_guest deve ritornare esattamente una riga');
      const g = r.rows[0];

      assert.equal(g.event_id, eventId);
      assert.equal(g.auth_uid, U1);
      assert.equal(g.nome, 'Mario');
      assert.ok(g.consenso_tos_at != null, 'consenso_tos_at non deve essere null');
      assert.match(String(g.pin), /^\d{4}$/, 'pin deve essere 4 cifre');

      assert.equal(g.saldo_normale, 0);
      assert.equal(g.saldo_premium, 0);
      assert.equal(g.ticket_consumo, 0);
      assert.equal(g.ticket_tap, 0);
      assert.equal(g.ticket_conversione, 0);
      assert.equal(g.ticket_totali, 0); // colonna generata = somma dei 3 ticket
      assert.equal(g.consumazioni_count, 0);
      assert.equal(g.livello_totem, 0);
      assert.ok(g.last_seen != null, 'last_seen non deve essere null');

      // last_seen vicino a now() (entro ~10s dall'avvio della call)
      const skewMs = Math.abs(new Date(g.last_seen).getTime() - before);
      assert.ok(skewMs < 10_000, `last_seen lontano da now(): ${skewMs}ms`);
    });
  });

  test('nome_vuoto_default_ospite — nome solo whitespace -> "Ospite"', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const r = await c.query('select * from register_guest($1, $2)', [eventId, '   ']);
      // coalesce(nullif(trim(p_nome), ''), 'Ospite')
      assert.equal(r.rows[0].nome, 'Ospite');
    });
  });

  test('idempotenza_stesso_sub_event — seconda call ritorna la stessa riga', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const first = (await c.query('select * from register_guest($1, $2)', [eventId, 'Mario']))
        .rows[0];

      // seconda call con nome diverso, stessa identità: deve essere idempotente
      const second = (await c.query('select * from register_guest($1, $2)', [eventId, 'Altro']))
        .rows[0];

      assert.equal(second.id, first.id, 'stesso id atteso (idempotenza)');
      assert.equal(second.pin, first.pin, 'stesso pin atteso (idempotenza)');
      assert.equal(second.nome, 'Mario', 'il nome resta quello della prima call');

      // esiste una sola riga per (event_id, auth_uid=U1)
      const cnt = await c.query(
        'select count(*)::int as n from guests where event_id = $1 and auth_uid = $2',
        [eventId, U1]
      );
      assert.equal(cnt.rows[0].n, 1);
    });
  });

  test('authz_senza_sub — claims senza sub -> auth.uid() null -> rifiuto', async () => {
    const { eventId } = await setup();

    // claims SENZA sub: auth.uid() risolve a null -> "autenticazione richiesta"
    await actAs({}, async (c) => {
      await assert.rejects(
        () => c.query('select * from register_guest($1, $2)', [eventId, 'X']),
        /autenticazione richiesta/
      );
    });
  });

  test('pin_unico_per_evento — due ospiti dello stesso evento hanno pin diversi', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();
    const U2 = randUuid();

    // I due register_guest devono stare nella STESSA tx perché il rollback di actAs
    // pulisce tutto a fine test: così verifichiamo l'unicità reale su (event_id,pin)
    // senza lasciare residui. Cambiamo l'identità ridefinendo i claims dentro la tx.
    await actAs(guestClaims(U1), async (c) => {
      const g1 = (await c.query('select * from register_guest($1, $2)', [eventId, 'Uno'])).rows[0];

      // diventa U2 nella stessa tx (set local request.jwt.claims)
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(guestClaims(U2)),
      ]);
      const g2 = (await c.query('select * from register_guest($1, $2)', [eventId, 'Due'])).rows[0];

      assert.match(String(g1.pin), /^\d{4}$/);
      assert.match(String(g2.pin), /^\d{4}$/);
      assert.notEqual(g1.pin, g2.pin, 'i due pin devono differire (unique event_id,pin)');
      assert.notEqual(g1.id, g2.id);
    });
  });

  test('consenso_tos_at_now — consenso ~ now() e coincide con created_at/last_seen', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const before = Date.now();
      const g = (await c.query('select * from register_guest($1, $2)', [eventId, 'Mario'])).rows[0];

      const tos = new Date(g.consenso_tos_at).getTime();
      const created = new Date(g.created_at).getTime();
      const seen = new Date(g.last_seen).getTime();

      assert.ok(Math.abs(tos - before) < 10_000, 'consenso_tos_at deve essere ~ now()');
      // register_guest usa now() (stesso statement-timestamp) per tutti e tre i campi:
      // consenso_tos_at = now(), last_seen = now(), created_at default now().
      assert.equal(tos, seen, 'consenso_tos_at deve coincidere con last_seen');
      assert.equal(tos, created, 'consenso_tos_at deve coincidere con created_at');
    });
  });
});
