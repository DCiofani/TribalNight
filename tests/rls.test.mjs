// tests/rls.test.mjs — Row Level Security REALE (v0.2): default-deny + SELECT mirate.
//
// Le RPC SECURITY DEFINER bypassano la RLS al loro interno (girano da owner); le
// query DIRETTE del test (role authenticated, claims via request.jwt.claims) sono
// invece soggette alla RLS. Ogni test crea i dati con le RPC e poi verifica cosa il
// ruolo corrente PUÒ leggere/scrivere. Tutto in una tx con rollback.
//
// Pattern multi-identità nella stessa tx: register_guest come U1, poi set_config dei
// claims a U2 e di nuovo register_guest, poi claims staff per topup/start/close, ecc.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  actAs,
  guestClaims,
  cassaClaims,
  regiaClaims,
  randUuid,
  closePool,
} from './db.mjs';

after(async () => {
  await closePool();
});

function setClaims(c, claims) {
  return c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
}

// Esegue una scrittura diretta che NON deve avere effetto sotto RLS. Due esiti leciti:
//  (a) errore "permission denied" / "row-level security" -> aborta la tx: il savepoint
//      la ripristina e contiamo 0 righe;
//  (b) statement permesso ma RLS filtra tutto -> rowCount 0.
// In entrambi i casi torniamo il numero di righe effettivamente toccate (atteso 0).
// Un eventuale errore NON di RLS viene rilanciato (il test deve fallire forte).
async function mutateExpectNoEffect(c, sql, params) {
  const sp = 'sp_' + Math.random().toString(36).slice(2, 10);
  await c.query(`savepoint ${sp}`);
  try {
    const r = await c.query(sql, params);
    await c.query(`release savepoint ${sp}`);
    return r.rowCount;
  } catch (err) {
    await c.query(`rollback to savepoint ${sp}`);
    await c.query(`release savepoint ${sp}`);
    if (!/(permission denied|row-level security|violates row-level)/i.test(err.message)) {
      throw err; // errore inatteso: propaga, il test deve rompersi
    }
    return 0;
  }
}

// Crea due guest GA(U1) e GB(U2) nello stesso evento, dentro la tx corrente.
// Lascia i claims impostati su quelli passati come `endClaims` (default: U1 ospite).
async function makeTwoGuests(c, eventId, U1, U2, endClaims) {
  await setClaims(c, guestClaims(U1));
  const GA = (await c.query('select * from register_guest($1,$2)', [eventId, 'GuestA'])).rows[0];
  await setClaims(c, guestClaims(U2));
  const GB = (await c.query('select * from register_guest($1,$2)', [eventId, 'GuestB'])).rows[0];
  if (endClaims) await setClaims(c, endClaims);
  return { GA, GB };
}

describe('RLS — guests', () => {
  test('rls_ospite_vede_solo_proprio_guest — U1 vede GA, non GB', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();
    const U2 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const { GA, GB } = await makeTwoGuests(c, eventId, U1, U2, guestClaims(U1));
      const ids = (await c.query('select id from guests')).rows.map((r) => r.id);
      assert.ok(ids.includes(GA.id), 'deve vedere il proprio guest GA');
      assert.ok(!ids.includes(GB.id), 'NON deve vedere GB');
    });
  });

  test('rls_staff_vede_tutti_i_guest — CASSA conta sia GA che GB', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();
    const U2 = randUuid();

    await actAs(cassaClaims(), async (c) => {
      // i guest vanno creati come ospiti; poi passiamo a CASSA per la SELECT
      const { GA, GB } = await makeTwoGuests(c, eventId, U1, U2, cassaClaims());
      const ids = (await c.query('select id from guests where event_id = $1', [eventId])).rows.map(
        (r) => r.id
      );
      assert.ok(ids.includes(GA.id) && ids.includes(GB.id), 'lo staff vede entrambi');
      const n = (await c.query('select count(*)::int as n from guests where event_id = $1', [eventId]))
        .rows[0].n;
      assert.ok(n >= 2);
    });
  });

  test('rls_ospite_non_vede_guest_altrui — select where auth_uid <> U1 -> 0 righe', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();
    const U2 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      await makeTwoGuests(c, eventId, U1, U2, guestClaims(U1));
      const r = await c.query('select count(*)::int as n from guests where auth_uid <> $1', [U1]);
      assert.equal(r.rows[0].n, 0, 'la policy auth_uid=auth.uid() nasconde gli altri');
    });
  });
});

describe('RLS — transactions', () => {
  test('rls_ospite_vede_solo_proprie_tx — U1(=GA) vede tx di GA non di GB', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();
    const U2 = randUuid();
    const Ucassa = randUuid();
    const idemA = randUuid();
    const idemB = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const { GA, GB } = await makeTwoGuests(c, eventId, U1, U2);

      // crea una tx per ciascun guest come CASSA (topup ricarica)
      await setClaims(c, cassaClaims(Ucassa));
      await c.query('select topup($1,$2,$3,$4,$5)', [GA.id, 'normale', 1, 5, idemA]);
      await c.query('select topup($1,$2,$3,$4,$5)', [GB.id, 'normale', 1, 5, idemB]);

      // ora come OSPITE U1 (=GA)
      await setClaims(c, guestClaims(U1));
      const ids = (await c.query('select id from transactions')).rows.map((r) => r.id);
      assert.ok(ids.includes(idemA), 'vede la propria tx (GA)');
      assert.ok(!ids.includes(idemB), 'NON vede la tx di GB');
    });
  });

  test('rls_insert_tx_negato_staff — la CASSA non può inserire nel ledger direttamente', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();

    await actAs(cassaClaims(), async (c) => {
      // serve un guest valido per l'FK; lo creiamo come ospite poi torniamo CASSA
      await setClaims(c, guestClaims(U1));
      const GA = (await c.query('select * from register_guest($1,$2)', [eventId, 'GuestA'])).rows[0];
      await setClaims(c, cassaClaims());

      await assert.rejects(
        () =>
          c.query(
            `insert into transactions (id, event_id, guest_id, tipo, qta_delta, ticket_delta)
             values ($1, $2, $3, 'ricarica', 1, 0)`,
            [randUuid(), eventId, GA.id]
          ),
        /(permission denied|row-level security|violates row-level)/i
      );
    });
  });
});

describe('RLS — taps', () => {
  test('rls_ospite_vede_solo_propri_taps — U1 vede solo righe con guest_id=GA', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();
    const U2 = randUuid();
    const Uregia = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const { GA, GB } = await makeTwoGuests(c, eventId, U1, U2);

      // la regia avvia una sessione di tap (solo APERTA) — evento TEST è APERTA
      await setClaims(c, regiaClaims(Uregia));
      const sess = (await c.query('select * from start_session($1, $2)', [eventId, 30])).rows[0];

      // ciascun ospite registra dei tap (register_taps usa auth.uid())
      await setClaims(c, guestClaims(U1));
      await c.query('select register_taps($1, $2)', [sess.id, 5]);
      await setClaims(c, guestClaims(U2));
      await c.query('select register_taps($1, $2)', [sess.id, 7]);

      // come OSPITE U1: vede solo i propri taps
      await setClaims(c, guestClaims(U1));
      const rows = (await c.query('select guest_id from taps')).rows.map((r) => r.guest_id);
      assert.ok(rows.includes(GA.id), 'vede i propri taps (GA)');
      assert.ok(!rows.includes(GB.id), 'NON vede i taps di GB');
    });
  });
});

describe('RLS — drinks', () => {
  test('rls_ospite_drinks_solo_visibili — ospite vede il visibile, non il nascosto', async () => {
    const { eventId, drinkNormale, drinkPremium } = await setup();
    const U1 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const ids = (await c.query('select id from drinks where event_id = $1', [eventId])).rows.map(
        (r) => r.id
      );
      assert.ok(ids.includes(drinkNormale), 'vede il drink visibile');
      assert.ok(!ids.includes(drinkPremium), 'NON vede il drink nascosto (visibile=false)');
    });
  });

  test('rls_staff_drinks_anche_nascosti — la CASSA vede anche il drink nascosto', async () => {
    const { eventId, drinkPremium } = await setup();

    await actAs(cassaClaims(), async (c) => {
      const ids = (await c.query('select id from drinks where event_id = $1', [eventId])).rows.map(
        (r) => r.id
      );
      assert.ok(ids.includes(drinkPremium), 'lo staff vede anche il drink nascosto');
    });
  });
});

describe('RLS — scritture dirette negate (default-deny)', () => {
  test('rls_insert_guests_negato_ospite — nessuna policy INSERT su guests', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      await assert.rejects(
        () =>
          c.query(
            'insert into guests (event_id, auth_uid, nome, pin) values ($1,$2,$3,$4)',
            [eventId, U1, 'Hacker', '1234']
          ),
        /(permission denied|row-level security|violates row-level)/i
      );
    });
  });

  test('rls_update_guests_negato_ospite — update del proprio saldo non ha effetto', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();

    await actAs(guestClaims(U1), async (c) => {
      const GA = (await c.query('select * from register_guest($1,$2)', [eventId, 'GuestA'])).rows[0];

      // nessuna policy UPDATE: o errore (permission denied -> aborta la tx, da cui il
      // savepoint), o 0 righe aggiornate (RLS filtra). In entrambi i casi il saldo deve
      // restare invariato.
      const affected = await mutateExpectNoEffect(
        c,
        'update guests set saldo_normale = 999 where id = $1',
        [GA.id]
      );
      assert.equal(affected, 0, 'nessuna riga aggiornata');

      // rileggiamo lo stato reale (la SELECT del proprio guest è permessa)
      const g = (await c.query('select saldo_normale from guests where id = $1', [GA.id])).rows[0];
      assert.equal(g.saldo_normale, 0, 'saldo_normale invariato');
    });
  });

  test('rls_update_events_negato_staff — la CASSA non può cambiare la fase via UPDATE', async () => {
    const { eventId } = await setup();

    await actAs(cassaClaims(), async (c) => {
      const affected = await mutateExpectNoEffect(
        c,
        "update events set fase = 'CHIUSA' where id = $1",
        [eventId]
      );
      assert.equal(affected, 0, 'nessuna policy UPDATE su events: fase solo via set_phase');

      const ev = (await c.query('select fase from events where id = $1', [eventId])).rows[0];
      assert.equal(ev.fase, 'APERTA', 'la fase resta APERTA');
    });
  });

  test('rls_delete_guests_negato_staff — la CASSA non può cancellare un guest', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();

    await actAs(cassaClaims(), async (c) => {
      await setClaims(c, guestClaims(U1));
      const GA = (await c.query('select * from register_guest($1,$2)', [eventId, 'GuestA'])).rows[0];
      await setClaims(c, cassaClaims());

      const affected = await mutateExpectNoEffect(c, 'delete from guests where id = $1', [GA.id]);
      assert.equal(affected, 0, 'nessuna riga cancellata');

      const n = (await c.query('select count(*)::int as n from guests where id = $1', [GA.id]))
        .rows[0].n;
      assert.equal(n, 1, 'GA ancora presente');
    });
  });
});
