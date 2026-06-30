// tests/consume.test.mjs — contratto REALE di public.consume (v0.2).
//
// consume(p_guest, p_drink, p_idem) — SECURITY DEFINER, solo staff, solo fase APERTA:
//   -1 dal saldo del TIPO del drink, +ticket_consumo_<tipo>, consumazioni_count+1,
//   livello_totem ricalcolato, riga ledger tipo='consumo' qta_delta=-1. Idempotente su p_idem.
//
// Pattern (come topup.test.mjs): dentro la tx creiamo il guest come OSPITE
// (register_guest), passiamo a claims CASSA per topup (per dare saldo) e poi consume.
// Rollback automatico a fine test (actAs). I drink arrivano da setup() (committati da
// owner): drinkNormale visibile+attivo, drinkPremium nascosto ma attivo (consume guarda
// `attivo`, non `visibile`). Per il caso "non attivo" creiamo un drink disattivato da
// owner DENTRO la tx (le RPC SECURITY DEFINER girano da owner, ma qui serve un INSERT
// diretto: lo facciamo con upsert_drink come regia, poi set_drink_active(false)).

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

// Dentro una tx già aperta: crea un guest come OSPITE, lo ricarica come CASSA con
// `qtaN` normali e `qtaP` premium, e lascia i claims su CASSA(sub=Ucassa).
// Ritorna { guestId, Uguest, Ucassa }.
async function makeGuestWithBalance(c, eventId, Ucassa, qtaN = 0, qtaP = 0) {
  const Uguest = randUuid();
  await setClaims(c, guestClaims(Uguest));
  const g = (await c.query('select * from register_guest($1, $2)', [eventId, 'Mario'])).rows[0];

  await setClaims(c, cassaClaims(Ucassa));
  if (qtaN > 0) {
    await c.query('select * from topup($1,$2,$3,$4,$5)', [g.id, 'normale', qtaN, qtaN * 5, randUuid()]);
  }
  if (qtaP > 0) {
    await c.query('select * from topup($1,$2,$3,$4,$5)', [g.id, 'premium', qtaP, qtaP * 8, randUuid()]);
  }
  return { guestId: g.id, Uguest, Ucassa };
}

describe('consume', () => {
  test('happy_normale — -1 saldo_normale, +ticket_consumo, tx consumo qta_delta=-1', async () => {
    const { eventId, drinkNormale } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestWithBalance(c, eventId, Ucassa, 2, 0);

      // ticket_consumo_normale di default = 4 (events). Leggiamo il valore reale dall'evento.
      const ev = (await c.query('select ticket_consumo_normale from events where id = $1', [eventId])).rows[0];

      const tx = (
        await c.query('select * from consume($1,$2,$3)', [guestId, drinkNormale, idem])
      ).rows[0];

      assert.equal(tx.id, idem);
      assert.equal(tx.tipo, 'consumo');
      assert.equal(tx.tipo_consumazione, 'normale');
      assert.equal(tx.qta_delta, -1, 'una consumazione scalata');
      assert.equal(tx.ticket_delta, ev.ticket_consumo_normale, 'ticket = ticket_consumo_normale');
      assert.equal(tx.operatore, Ucassa);
      assert.equal(tx.event_id, eventId);

      const g = (
        await c.query(
          'select saldo_normale, saldo_premium, ticket_consumo, consumazioni_count, livello_totem from guests where id = $1',
          [guestId]
        )
      ).rows[0];
      assert.equal(g.saldo_normale, 1, 'saldo_normale 2 -> 1');
      assert.equal(g.saldo_premium, 0, 'saldo_premium invariato');
      assert.equal(g.ticket_consumo, ev.ticket_consumo_normale, 'ticket_consumo accumulato');
      assert.equal(g.consumazioni_count, 1, 'consumazioni_count +1');
      assert.equal(g.livello_totem, 1, 'totem_level(1) = 1');
    });
  });

  test('happy_premium — -1 saldo_premium, +ticket_consumo_premium, normale invariato', async () => {
    const { eventId, drinkPremium } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestWithBalance(c, eventId, Ucassa, 1, 1);
      const ev = (await c.query('select ticket_consumo_premium from events where id = $1', [eventId])).rows[0];

      // drinkPremium da setup() è tipo='premium', visibile=false ma attivo=true: consumabile.
      const tx = (
        await c.query('select * from consume($1,$2,$3)', [guestId, drinkPremium, idem])
      ).rows[0];

      assert.equal(tx.tipo, 'consumo');
      assert.equal(tx.tipo_consumazione, 'premium');
      assert.equal(tx.qta_delta, -1);
      assert.equal(tx.ticket_delta, ev.ticket_consumo_premium);

      const g = (
        await c.query('select saldo_normale, saldo_premium, ticket_consumo from guests where id = $1', [guestId])
      ).rows[0];
      assert.equal(g.saldo_premium, 0, 'saldo_premium 1 -> 0');
      assert.equal(g.saldo_normale, 1, 'saldo_normale invariato');
      assert.equal(g.ticket_consumo, ev.ticket_consumo_premium);
    });
  });

  test('idempotenza_stesso_idem — secondo consume stesso idem: 1 sola riga, nessun doppio decremento', async () => {
    const { eventId, drinkNormale } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestWithBalance(c, eventId, Ucassa, 3, 0);

      const first = (await c.query('select * from consume($1,$2,$3)', [guestId, drinkNormale, idem])).rows[0];
      const second = (await c.query('select * from consume($1,$2,$3)', [guestId, drinkNormale, idem])).rows[0];

      assert.equal(second.id, first.id, 'stessa tx (idempotenza su idem)');

      const cnt = (await c.query('select count(*)::int as n from transactions where id = $1', [idem])).rows[0];
      assert.equal(cnt.n, 1, 'una sola riga nel ledger per quell idem');

      const g = (
        await c.query('select saldo_normale, consumazioni_count from guests where id = $1', [guestId])
      ).rows[0];
      assert.equal(g.saldo_normale, 2, 'saldo 3 -> 2 una sola volta (NON 1)');
      assert.equal(g.consumazioni_count, 1, 'consumazioni_count NON raddoppia');
    });
  });

  test('saldo_insufficiente_normale — saldo 0 -> raise, nessuna mutazione, nessuna tx', async () => {
    const { eventId, drinkNormale } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestWithBalance(c, eventId, Ucassa, 0, 0);

      await expectReject(
        c,
        'select * from consume($1,$2,$3)',
        [guestId, drinkNormale, idem],
        /saldo NORMALE insufficiente/
      );

      const g = (
        await c.query('select saldo_normale, ticket_consumo, consumazioni_count from guests where id = $1', [guestId])
      ).rows[0];
      assert.equal(g.saldo_normale, 0, 'saldo invariato');
      assert.equal(g.ticket_consumo, 0, 'nessun ticket');
      assert.equal(g.consumazioni_count, 0, 'nessuna consumazione contata');

      const n = (await c.query('select count(*)::int as n from transactions where id = $1', [idem])).rows[0].n;
      assert.equal(n, 0, 'nessuna tx creata');
    });
  });

  test('saldo_insufficiente_premium — premium 0 -> raise, normale intatto', async () => {
    const { eventId, drinkPremium } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      // ha solo saldo normale, niente premium
      const { guestId } = await makeGuestWithBalance(c, eventId, Ucassa, 2, 0);

      await expectReject(
        c,
        'select * from consume($1,$2,$3)',
        [guestId, drinkPremium, idem],
        /saldo PREMIUM insufficiente/
      );

      const g = (
        await c.query('select saldo_normale, saldo_premium from guests where id = $1', [guestId])
      ).rows[0];
      assert.equal(g.saldo_premium, 0);
      assert.equal(g.saldo_normale, 2, 'il saldo normale non viene toccato');
    });
  });

  test('drink_random_inesistente — drink id non in tabella -> raise drink non valido', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestWithBalance(c, eventId, Ucassa, 2, 0);

      await expectReject(
        c,
        'select * from consume($1,$2,$3)',
        [guestId, randUuid(), idem],
        /drink non valido o non attivo/
      );

      const g = (await c.query('select saldo_normale from guests where id = $1', [guestId])).rows[0];
      assert.equal(g.saldo_normale, 2, 'saldo invariato');
    });
  });

  test('drink_non_attivo — drink disattivato (attivo=false) -> raise, nessun decremento', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const Uregia = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestWithBalance(c, eventId, Ucassa, 2, 0);

      // la regia crea un drink e lo disattiva, DENTRO la tx (rollback ripristina)
      await setClaims(c, regiaClaims(Uregia));
      const d = (
        await c.query('select * from upsert_drink($1,$2,$3,$4)', [eventId, null, 'Spento', 'normale'])
      ).rows[0];
      await c.query('select * from set_drink_active($1,$2)', [d.id, false]);

      // torna CASSA e prova a consumare il drink disattivato
      await setClaims(c, cassaClaims(Ucassa));
      await expectReject(
        c,
        'select * from consume($1,$2,$3)',
        [guestId, d.id, idem],
        /drink non valido o non attivo/
      );

      const g = (await c.query('select saldo_normale from guests where id = $1', [guestId])).rows[0];
      assert.equal(g.saldo_normale, 2, 'saldo invariato (drink non attivo)');
    });
  });

  test('gating_fase_non_aperta — LAST_CALL blocca il bar, nessuna mutazione', async () => {
    const { eventId, drinkNormale } = await setup();
    const Ucassa = randUuid();
    const Uregia = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestWithBalance(c, eventId, Ucassa, 2, 0);

      // la regia porta a LAST_CALL (dopo aver ricaricato in APERTA)
      await setClaims(c, regiaClaims(Uregia));
      await c.query('select set_phase($1,$2)', [eventId, 'LAST_CALL']);

      await setClaims(c, cassaClaims(Ucassa));
      await expectReject(
        c,
        'select * from consume($1,$2,$3)',
        [guestId, drinkNormale, idem],
        /bar non operativo nella fase LAST_CALL/
      );

      const g = (await c.query('select saldo_normale from guests where id = $1', [guestId])).rows[0];
      assert.equal(g.saldo_normale, 2, 'saldo invariato in fase non APERTA');
      const n = (await c.query('select count(*)::int as n from transactions where id = $1', [idem])).rows[0].n;
      assert.equal(n, 0, 'nessuna tx');
    });
  });

  test('authz_ospite_non_staff — un ospite non può consumare, nessuna tx', async () => {
    const { eventId, drinkNormale } = await setup();
    const Uguest = randUuid();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(guestClaims(Uguest), async (c) => {
      // crea il guest come OSPITE
      const g = (await c.query('select * from register_guest($1,$2)', [eventId, 'Mario'])).rows[0];
      // gli diamo saldo come CASSA, così l'errore non può essere "saldo insufficiente"
      await setClaims(c, cassaClaims(Ucassa));
      await c.query('select * from topup($1,$2,$3,$4,$5)', [g.id, 'normale', 2, 10, randUuid()]);

      // torna OSPITE: consume deve rifiutare per authz
      await setClaims(c, guestClaims(Uguest));
      await expectReject(
        c,
        'select * from consume($1,$2,$3)',
        [g.id, drinkNormale, idem],
        /operazione riservata allo staff/
      );

      const after = (await c.query('select saldo_normale from guests where id = $1', [g.id])).rows[0];
      assert.equal(after.saldo_normale, 2, 'saldo invariato');
      const n = (await c.query('select count(*)::int as n from transactions where id = $1', [idem])).rows[0].n;
      assert.equal(n, 0, 'nessuna tx di consumo');
    });
  });
});
