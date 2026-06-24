// tests/topup.test.mjs — contratto REALE di public.topup (v0.2).
// Pattern: dentro la tx creiamo l'ospite con claims OSPITE (register_guest), poi
// passiamo a claims CASSA (set local request.jwt.claims) per fare il topup sullo
// stesso guest.id. Rollback a fine test. Asserzioni vere su saldo, ledger, errori.

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

// Helper: dentro una tx già aperta, crea un guest (come OSPITE) e poi riporta i
// claims a CASSA con sub=Ucassa. Ritorna { guestId, Uguest, Ucassa }.
async function makeGuestThenCassa(c, eventId, Ucassa) {
  const Uguest = randUuid();
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(guestClaims(Uguest)),
  ]);
  const g = (await c.query('select * from register_guest($1, $2)', [eventId, 'Mario'])).rows[0];

  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(cassaClaims(Ucassa)),
  ]);
  return { guestId: g.id, Uguest, Ucassa };
}

describe('topup', () => {
  test('happy_normale — +3 saldo_normale, tx ricarica coerente', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    // partiamo dai claims CASSA; dentro creiamo il guest e torniamo a CASSA
    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestThenCassa(c, eventId, Ucassa);

      const tx = (
        await c.query('select * from topup($1, $2, $3, $4, $5)', [
          guestId,
          'normale',
          3,
          15.0,
          idem,
        ])
      ).rows[0];

      assert.equal(tx.tipo, 'ricarica');
      assert.equal(tx.tipo_consumazione, 'normale');
      assert.equal(tx.qta_delta, 3);
      assert.equal(tx.ticket_delta, 0);
      assert.equal(Number(tx.importo_euro), 15.0);
      assert.equal(tx.operatore, Ucassa);
      assert.equal(tx.event_id, eventId);
      assert.equal(tx.id, idem);

      // stato DB: saldo aggiornato (lettura da CASSA, RLS staff vede tutto)
      const g = (await c.query('select saldo_normale, saldo_premium from guests where id = $1', [
        guestId,
      ])).rows[0];
      assert.equal(g.saldo_normale, 3);
      assert.equal(g.saldo_premium, 0);
    });
  });

  test('happy_premium — +2 saldo_premium, normale invariato', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestThenCassa(c, eventId, Ucassa);

      const tx = (
        await c.query('select * from topup($1, $2, $3, $4, $5)', [
          guestId,
          'premium',
          2,
          16.0,
          idem,
        ])
      ).rows[0];

      assert.equal(tx.tipo_consumazione, 'premium');
      assert.equal(tx.qta_delta, 2);
      assert.equal(tx.ticket_delta, 0);
      assert.equal(Number(tx.importo_euro), 16.0);

      const g = (await c.query('select saldo_normale, saldo_premium from guests where id = $1', [
        guestId,
      ])).rows[0];
      assert.equal(g.saldo_premium, 2);
      assert.equal(g.saldo_normale, 0);
    });
  });

  test('idempotenza_stesso_idem — seconda topup stesso idem ritorna la stessa tx, saldo non raddoppia', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestThenCassa(c, eventId, Ucassa);

      const first = (
        await c.query('select * from topup($1,$2,$3,$4,$5)', [guestId, 'normale', 3, 15, idem])
      ).rows[0];
      const second = (
        await c.query('select * from topup($1,$2,$3,$4,$5)', [guestId, 'normale', 3, 15, idem])
      ).rows[0];

      assert.equal(second.id, first.id, 'stessa tx (idempotenza su idem)');

      const cnt = await c.query('select count(*)::int as n from transactions where id = $1', [idem]);
      assert.equal(cnt.rows[0].n, 1, 'una sola riga nel ledger per quell idem');

      const g = (await c.query('select saldo_normale from guests where id = $1', [guestId])).rows[0];
      assert.equal(g.saldo_normale, 3, 'saldo resta 3, NON 6');
    });
  });

  test('gating_fase_non_aperta — LAST_CALL blocca la ricarica, nessuna tx, saldo invariato', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const Uregia = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestThenCassa(c, eventId, Ucassa);

      // la regia porta l'evento a LAST_CALL via set_phase, DENTRO la tx (rollback ripristina)
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(regiaClaims(Uregia)),
      ]);
      await c.query('select set_phase($1, $2)', [eventId, 'LAST_CALL']);

      // torna CASSA e prova la ricarica
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(cassaClaims(Ucassa)),
      ]);
      await expectReject(
        c,
        'select * from topup($1,$2,$3,$4,$5)',
        [guestId, 'normale', 1, 5, idem],
        /ricariche disabilitate nella fase LAST_CALL/
      );

      const tx = await c.query('select count(*)::int as n from transactions where id = $1', [idem]);
      assert.equal(tx.rows[0].n, 0, 'nessuna tx creata');
      const g = (await c.query('select saldo_normale from guests where id = $1', [guestId])).rows[0];
      assert.equal(g.saldo_normale, 0, 'saldo invariato');
    });
  });

  test('authz_ospite_non_staff — un ospite non può ricaricare, nessuna tx', async () => {
    const { eventId } = await setup();
    const Uguest = randUuid();
    const idem = randUuid();

    await actAs(guestClaims(Uguest), async (c) => {
      const g = (await c.query('select * from register_guest($1, $2)', [eventId, 'Mario'])).rows[0];

      // resta OSPITE (nessun role): topup deve rifiutare
      await expectReject(
        c,
        'select * from topup($1,$2,$3,$4,$5)',
        [g.id, 'normale', 1, 5, idem],
        /operazione riservata allo staff/
      );

      const tx = await c.query('select count(*)::int as n from transactions where id = $1', [idem]);
      assert.equal(tx.rows[0].n, 0, 'nessuna riga in transactions');
    });
  });

  test('validation_qta_non_positiva — qta 0 e -1 rifiutate, saldo invariato', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();
    const idem2 = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestThenCassa(c, eventId, Ucassa);

      await expectReject(
        c,
        'select * from topup($1,$2,$3,$4,$5)',
        [guestId, 'normale', 0, 5, idem],
        /quantità non valida/
      );
      await expectReject(
        c,
        'select * from topup($1,$2,$3,$4,$5)',
        [guestId, 'normale', -1, 5, idem2],
        /quantità non valida/
      );

      const g = (await c.query('select saldo_normale from guests where id = $1', [guestId])).rows[0];
      assert.equal(g.saldo_normale, 0, 'saldo invariato');
    });
  });

  test('validation_tipo_non_valido — tipo "birra" rifiutato, saldo invariato', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestThenCassa(c, eventId, Ucassa);

      await expectReject(
        c,
        'select * from topup($1,$2,$3,$4,$5)',
        [guestId, 'birra', 1, 5, idem],
        /tipo consumazione non valido/
      );

      const g = (await c.query('select saldo_normale, saldo_premium from guests where id = $1', [
        guestId,
      ])).rows[0];
      assert.equal(g.saldo_normale, 0);
      assert.equal(g.saldo_premium, 0);
    });
  });

  test('guest_inesistente — guest random rifiutato', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      // creiamo comunque un guest per coerenza, ma chiamiamo topup su un id random
      await makeGuestThenCassa(c, eventId, Ucassa);

      await assert.rejects(
        () => c.query('select * from topup($1,$2,$3,$4,$5)', [randUuid(), 'normale', 1, 5, idem]),
        /ospite inesistente/
      );
    });
  });

  test('ordine_authz_prima_di_validation — ospite + tipo invalido -> errore di authz, non di validazione', async () => {
    const { eventId } = await setup();
    const Uguest = randUuid();
    const idem = randUuid();

    await actAs(guestClaims(Uguest), async (c) => {
      const g = (await c.query('select * from register_guest($1, $2)', [eventId, 'Mario'])).rows[0];

      // OSPITE + tipo 'birra' (anch'esso invalido): poiché l'authz precede la
      // validazione del tipo, il messaggio DEVE essere quello dello staff.
      await assert.rejects(
        () => c.query('select * from topup($1,$2,$3,$4,$5)', [g.id, 'birra', 1, 5, idem]),
        (err) => {
          assert.match(err.message, /operazione riservata allo staff/);
          assert.doesNotMatch(err.message, /tipo consumazione non valido/);
          return true;
        }
      );
    });
  });

  test('R01_idem_riusato_parametri_diversi — stesso idem, parametri diversi -> ritorna la tx ORIGINALE (finding R-01)', async () => {
    // FINDING R-01: idempotency-key collision senza mismatch detection.
    // topup fa "select * from transactions where id = p_idem; if found then return v_tx;"
    // PRIMA di validare/applicare i nuovi parametri. Quindi riusare lo stesso idem con
    // tipo/qta/importo DIVERSI restituisce silenziosamente la transazione originale e
    // ignora i nuovi parametri: nessun errore, nessun mismatch sollevato.
    //
    // Nota concorrenza: questo test è single-connection e dimostra solo il ritorno
    // idempotente in sequenza. La RACE reale (due topup concorrenti con stesso idem)
    // non è coperta qui: in quel caso il secondo INSERT colliderebbe sulla PK di
    // transactions (id primary key) e fallirebbe con unique_violation — comportamento
    // diverso, non testabile su una sola connessione.
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestThenCassa(c, eventId, Ucassa);

      const original = (
        await c.query('select * from topup($1,$2,$3,$4,$5)', [guestId, 'normale', 3, 15, idem])
      ).rows[0];

      // stesso idem, ma tipo/qta/importo COMPLETAMENTE diversi
      const replay = (
        await c.query('select * from topup($1,$2,$3,$4,$5)', [guestId, 'premium', 9, 99, idem])
      ).rows[0];

      // ritorna la ORIGINALE, i nuovi parametri sono ignorati
      assert.equal(replay.id, original.id);
      assert.equal(replay.tipo_consumazione, 'normale', 'resta normale, non premium');
      assert.equal(replay.qta_delta, 3, 'resta 3, non 9');
      assert.equal(Number(replay.importo_euro), 15, 'resta 15, non 99');

      const g = (await c.query('select saldo_normale, saldo_premium from guests where id = $1', [
        guestId,
      ])).rows[0];
      assert.equal(g.saldo_normale, 3, 'saldo_normale resta 3 (solo la prima topup ha effetto)');
      assert.equal(g.saldo_premium, 0, 'saldo_premium resta 0: i parametri del replay sono ignorati');
    });
  });

  test('operatore_uid_cassa — transactions.operatore = sub della cassa', async () => {
    const { eventId } = await setup();
    const Ucassa = randUuid();
    const idem = randUuid();

    await actAs(cassaClaims(Ucassa), async (c) => {
      const { guestId } = await makeGuestThenCassa(c, eventId, Ucassa);

      const tx = (
        await c.query('select * from topup($1,$2,$3,$4,$5)', [guestId, 'normale', 1, 5, idem])
      ).rows[0];
      assert.equal(tx.operatore, Ucassa);
    });
  });
});
