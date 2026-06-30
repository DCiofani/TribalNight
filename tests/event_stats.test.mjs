// tests/event_stats.test.mjs — contratto REALE di public.event_stats(p_event) (0005).
//
// event_stats(p_event) RETURNS TABLE(fase text, presenze int, gettoni_venduti bigint,
// ticket_totali bigint), SECURITY DEFINER, gate is_staff() (errcode P0001). I numeri:
//   * fase            = events.fase
//   * presenze        = count(*) guests dell'evento
//   * gettoni_venduti = sum(transactions.qta_delta) where tipo='ricarica'
//   * ticket_totali   = sum(guests.ticket_totali)  [colonna GENERATED: consumo+tap+conversione]
//
// Verifichiamo coerenza coi GREZZI calcolati a parte nella stessa tx (server-authoritative:
// il front-end non calcola nulla, qui validiamo che l'RPC == i grezzi del DB). Tutto in
// una tx con rollback (actAs). I gettoni "venduti" derivano da topup (ricarica), i ticket
// da consume (ticket_consumo) e dai tap. Usiamo lo staff per leggere; l'ospite è negato.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  actAs,
  guestClaims,
  cassaClaims,
  regiaClaims,
  randUuid,
  expectReject,
  closePool,
} from './db.mjs';

after(async () => {
  await closePool();
});

function setClaims(c, claims) {
  return c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
}

// Legge i GREZZI direttamente dalle tabelle (come staff: la RLS gli mostra tutto),
// così possiamo confrontare l'RPC contro la realtà del DB.
async function rawStats(c, eventId) {
  const fase = (await c.query('select fase from events where id = $1', [eventId])).rows[0].fase;
  const presenze = (await c.query('select count(*)::int as n from guests where event_id = $1', [eventId])).rows[0].n;
  const gettoni = (
    await c.query(
      "select coalesce(sum(qta_delta),0)::bigint as s from transactions where event_id=$1 and tipo='ricarica'",
      [eventId]
    )
  ).rows[0].s;
  const ticket = (
    await c.query('select coalesce(sum(ticket_totali),0)::bigint as s from guests where event_id = $1', [eventId])
  ).rows[0].s;
  return { fase, presenze, gettoni_venduti: gettoni, ticket_totali: ticket };
}

describe('event_stats', () => {
  test('coerenza_con_grezzi — presenze/gettoni/ticket coincidono coi conteggi del DB + fase', async () => {
    const { eventId, drinkNormale } = await setup();
    const Ucassa = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      // 2 ospiti registrati (presenze attese: i grezzi includono eventuali ospiti
      // residui di setup; confrontiamo SEMPRE l'RPC con rawStats nella stessa tx).
      const subs = [randUuid(), randUuid()];
      const guests = [];
      for (const sub of subs) {
        await setClaims(c, guestClaims(sub));
        const g = (await c.query('select * from register_guest($1,$2)', [eventId, 'G'])).rows[0];
        guests.push(g.id);
      }

      // cassa: ricariche (gettoni_venduti = somma qta_delta delle ricariche) + un consumo
      // (genera ticket_consumo, quindi ticket_totali > 0).
      await setClaims(c, cassaClaims(Ucassa));
      await c.query('select * from topup($1,$2,$3,$4,$5)', [guests[0], 'normale', 3, 15, randUuid()]); // +3 gettoni
      await c.query('select * from topup($1,$2,$3,$4,$5)', [guests[1], 'premium', 2, 16, randUuid()]); // +2 gettoni
      await c.query('select * from consume($1,$2,$3)', [guests[0], drinkNormale, randUuid()]); // +ticket_consumo, -1 saldo

      const raw = await rawStats(c, eventId);
      const rpc = (await c.query('select * from event_stats($1)', [eventId])).rows[0];

      assert.equal(rpc.fase, raw.fase, 'fase coerente');
      assert.equal(rpc.fase, 'APERTA', 'evento TEST è APERTA');
      assert.equal(Number(rpc.presenze), Number(raw.presenze), 'presenze = count guests');
      assert.ok(Number(rpc.presenze) >= 2, 'almeno i 2 ospiti appena creati');
      assert.equal(Number(rpc.gettoni_venduti), Number(raw.gettoni_venduti), 'gettoni_venduti = somma ricariche');
      assert.equal(Number(rpc.gettoni_venduti), 5, '3 normali + 2 premium = 5 gettoni venduti');
      assert.equal(Number(rpc.ticket_totali), Number(raw.ticket_totali), 'ticket_totali = somma guests.ticket_totali');
      assert.ok(Number(rpc.ticket_totali) > 0, 'il consumo ha generato ticket');
    });
  });

  test('gettoni_solo_ricariche — i consumi (qta_delta negativo) non contano nei gettoni_venduti', async () => {
    const { eventId, drinkNormale } = await setup();
    const Ucassa = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const sub = randUuid();
      await setClaims(c, guestClaims(sub));
      const g = (await c.query('select * from register_guest($1,$2)', [eventId, 'G'])).rows[0];

      await setClaims(c, cassaClaims(Ucassa));
      await c.query('select * from topup($1,$2,$3,$4,$5)', [g.id, 'normale', 4, 20, randUuid()]); // +4 gettoni
      // due consumi: qta_delta=-1 ciascuno, tipo='consumo' -> NON contati in gettoni_venduti
      await c.query('select * from consume($1,$2,$3)', [g.id, drinkNormale, randUuid()]);
      await c.query('select * from consume($1,$2,$3)', [g.id, drinkNormale, randUuid()]);

      const rpc = (await c.query('select * from event_stats($1)', [eventId])).rows[0];
      const raw = await rawStats(c, eventId);

      assert.equal(Number(rpc.gettoni_venduti), 4, 'solo le ricariche: i 2 consumi (-1) non scalano i gettoni venduti');
      assert.equal(Number(rpc.gettoni_venduti), Number(raw.gettoni_venduti));
    });
  });

  test('fase_riflette_set_phase — la fase nell RPC segue set_phase della regia', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      await c.query('select set_phase($1,$2)', [eventId, 'LAST_CALL']);
      const rpc = (await c.query('select * from event_stats($1)', [eventId])).rows[0];
      assert.equal(rpc.fase, 'LAST_CALL', 'event_stats riporta la fase corrente');
    });
  });

  test('authz_ospite — un ospite non-staff non può leggere le stats', async () => {
    const { eventId } = await setup();
    const Uguest = randUuid();

    await actAs(guestClaims(Uguest), async (c) => {
      // anche da ospite registrato: il gate is_staff() blocca
      await c.query('select * from register_guest($1,$2)', [eventId, 'G']);
      await expectReject(
        c,
        'select * from event_stats($1)',
        [eventId],
        /operazione riservata allo staff/
      );
    });
  });

  test('authz_cassa_ok — la CASSA (staff) può leggere le stats', async () => {
    const { eventId } = await setup();

    await actAs(cassaClaims(), async (c) => {
      const rows = (await c.query('select * from event_stats($1)', [eventId])).rows;
      assert.equal(rows.length, 1, 'una riga di stats');
      assert.equal(rows[0].fase, 'APERTA');
    });
  });
});
