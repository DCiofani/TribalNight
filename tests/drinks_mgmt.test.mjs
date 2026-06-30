// tests/drinks_mgmt.test.mjs — contratto REALE delle RPC di gestione MENÙ (v0.2):
//   upsert_drink, set_drink_visibility, set_drink_active, delete_drink.
//
// Tutte e 4 le RPC sono SECURITY DEFINER e richiedono is_staff('regia') (vedi
// 0001_init.sql §4.11–4.14): cassa NON basta, ospite nemmeno -> raise 'solo regia/admin'.
// upsert_drink: p_id NULL = INSERT nuova voce; p_id esistente = UPDATE (where id=p_id
// AND event_id=p_event); se non trova -> raise 'voce di menù inesistente'.
// set_drink_visibility / set_drink_active: flip booleano per id, raise 'voce di menù
// inesistente' se l'id non esiste. delete_drink: DELETE per id, returns void.
//
// Read-scope (RLS drinks_select = `visibile = true OR is_staff()`, riga 201-202 di
// 0001_init.sql): è la semantica che alimenta scope=visible (ospite) vs scope=all (staff).
// Verifichiamo direttamente sotto RLS che l'ospite NON veda il drink premium nascosto
// (visibile=false) seedato in setup(), mentre lo staff sì.
//
// Tutto in una tx con rollback automatico (actAs): l'evento TEST di setup() è APERTA e ha
// un drink normale visibile + un drink premium nascosto (visibile=false). Le RPC girano
// come owner (SECURITY DEFINER) e bypassano la RLS; le SELECT dirette del test (role
// authenticated) sono soggette alla RLS — è ciò che i test read-scope verificano.

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

// Colonne canoniche di una voce di menù = identiche a DrinkRow (lib/rpc.ts) e a ciò
// che SELECTano gli scope active/visible/all di GET /api/regia/drink.
const DRINK_COLS = [
  'id',
  'event_id',
  'nome',
  'tipo',
  'descrizione',
  'categoria',
  'immagine_url',
  'ordine',
  'visibile',
  'attivo',
];

describe('menù — upsert_drink (regia)', () => {
  test('insert_nuova_voce — p_id NULL crea una voce con i campi passati', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      const d = (
        await c.query(
          // p_event, p_id(null=insert), p_nome, p_tipo, p_descrizione, p_categoria,
          // p_immagine_url, p_ordine, p_visibile, p_attivo
          'select * from upsert_drink($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            eventId,
            null,
            'Negroni TEST',
            'premium',
            'Bitter, vermouth, gin',
            'Cocktail',
            'https://img/negroni.png',
            7,
            true,
            true,
          ]
        )
      ).rows[0];

      // la RPC ritorna la riga drinks completa (RETURNING *): verifichiamo le colonne.
      for (const col of DRINK_COLS) {
        assert.ok(col in d, `la riga ritornata espone la colonna ${col}`);
      }
      assert.ok(d.id, 'id generato (gen_random_uuid)');
      assert.equal(d.event_id, eventId, 'event_id = p_event');
      assert.equal(d.nome, 'Negroni TEST');
      assert.equal(d.tipo, 'premium');
      assert.equal(d.descrizione, 'Bitter, vermouth, gin');
      assert.equal(d.categoria, 'Cocktail');
      assert.equal(d.immagine_url, 'https://img/negroni.png');
      assert.equal(d.ordine, 7);
      assert.equal(d.visibile, true);
      assert.equal(d.attivo, true);

      // realmente persistita nella tabella (sotto RLS staff la vede: regia = is_staff)
      const persisted = (
        await c.query('select nome, tipo, ordine from drinks where id = $1', [d.id])
      ).rows[0];
      assert.equal(persisted.nome, 'Negroni TEST', 'INSERT persistito su drinks');
      assert.equal(persisted.tipo, 'premium');
      assert.equal(persisted.ordine, 7);
    });
  });

  test('update_voce_esistente — p_id valorizzato modifica la voce', async () => {
    const { eventId, drinkNormale } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      const d = (
        await c.query('select * from upsert_drink($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
          eventId,
          drinkNormale, // p_id esistente => UPDATE
          'Birra TEST (rinominata)',
          'normale',
          'Spina 0.4',
          'Birre',
          null,
          3,
          true,
          false, // attivo -> false
        ])
      ).rows[0];

      assert.equal(d.id, drinkNormale, 'stesso id (update in place)');
      assert.equal(d.event_id, eventId);
      assert.equal(d.nome, 'Birra TEST (rinominata)', 'nome aggiornato');
      assert.equal(d.descrizione, 'Spina 0.4');
      assert.equal(d.categoria, 'Birre');
      assert.equal(d.immagine_url, null);
      assert.equal(d.ordine, 3, 'ordine aggiornato');
      assert.equal(d.attivo, false, 'attivo aggiornato a false');

      const persisted = (
        await c.query('select nome, attivo, ordine from drinks where id = $1', [drinkNormale])
      ).rows[0];
      assert.equal(persisted.nome, 'Birra TEST (rinominata)', 'UPDATE persistito su drinks');
      assert.equal(persisted.attivo, false);
      assert.equal(persisted.ordine, 3);
    });
  });

  test('update_id_inesistente — p_id sconosciuto -> raise voce inesistente', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      await expectReject(
        c,
        'select * from upsert_drink($1,$2,$3,$4)',
        [eventId, randUuid(), 'Fantasma', 'normale'],
        /voce di menù inesistente/
      );
    });
  });

  test('tipo_non_valido — p_tipo fuori da (normale,premium) -> raise', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      await expectReject(
        c,
        'select * from upsert_drink($1,$2,$3,$4)',
        [eventId, null, 'Strano', 'superalcolico'],
        /tipo non valido: superalcolico/
      );
    });
  });
});

describe('menù — set_drink_visibility / set_drink_active (regia)', () => {
  test('visibility_flip — true<->false come regia, effetto su drinks', async () => {
    const { drinkPremium } = await setup(); // premium nascosto: visibile=false in setup
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      // parte da false (seed): porto a true
      const on = (
        await c.query('select * from set_drink_visibility($1,$2)', [drinkPremium, true])
      ).rows[0];
      assert.equal(on.id, drinkPremium);
      assert.equal(on.visibile, true, 'RPC ritorna la riga con visibile=true');
      let chk = (await c.query('select visibile from drinks where id=$1', [drinkPremium])).rows[0];
      assert.equal(chk.visibile, true, 'persistito su drinks');

      // torno a false
      const off = (
        await c.query('select * from set_drink_visibility($1,$2)', [drinkPremium, false])
      ).rows[0];
      assert.equal(off.visibile, false);
      chk = (await c.query('select visibile from drinks where id=$1', [drinkPremium])).rows[0];
      assert.equal(chk.visibile, false, 'flip false persistito');
    });
  });

  test('active_flip — true<->false come regia, effetto su drinks', async () => {
    const { drinkNormale } = await setup(); // attivo=true in setup
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      const off = (
        await c.query('select * from set_drink_active($1,$2)', [drinkNormale, false])
      ).rows[0];
      assert.equal(off.id, drinkNormale);
      assert.equal(off.attivo, false, 'RPC ritorna riga con attivo=false');
      // set_drink_active NON tocca visibile
      assert.equal(off.visibile, true, 'visibile resta invariato dal flip su attivo');
      let chk = (await c.query('select attivo from drinks where id=$1', [drinkNormale])).rows[0];
      assert.equal(chk.attivo, false, 'persistito su drinks');

      const on = (
        await c.query('select * from set_drink_active($1,$2)', [drinkNormale, true])
      ).rows[0];
      assert.equal(on.attivo, true);
      chk = (await c.query('select attivo from drinks where id=$1', [drinkNormale])).rows[0];
      assert.equal(chk.attivo, true, 'flip true persistito');
    });
  });

  test('id_inesistente — set_drink_visibility/active su id ignoto -> raise', async () => {
    await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      await expectReject(
        c,
        'select * from set_drink_visibility($1,$2)',
        [randUuid(), true],
        /voce di menù inesistente/
      );
      await expectReject(
        c,
        'select * from set_drink_active($1,$2)',
        [randUuid(), true],
        /voce di menù inesistente/
      );
    });
  });
});

describe('menù — delete_drink (regia)', () => {
  test('delete_rimuove_voce — la voce sparisce da drinks', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      // creo una voce ad-hoc da cancellare (non tocco i seed condivisi)
      const d = (
        await c.query('select * from upsert_drink($1,$2,$3,$4)', [
          eventId,
          null,
          'Da cancellare',
          'normale',
        ])
      ).rows[0];
      let n = (await c.query('select count(*)::int as n from drinks where id=$1', [d.id]))
        .rows[0].n;
      assert.equal(n, 1, 'voce presente prima del delete');

      const del = await c.query('select delete_drink($1) as r', [d.id]);
      assert.equal(del.rows[0].r, '', 'delete_drink returns void');

      n = (await c.query('select count(*)::int as n from drinks where id=$1', [d.id])).rows[0].n;
      assert.equal(n, 0, 'voce rimossa da drinks');
    });
  });
});

describe('menù — RBAC: le 4 RPC sono solo-regia', () => {
  // cassa e ospite devono essere respinti con 'solo regia/admin' su tutte e 4.
  async function assertAllRejected(c, eventId, drinkId) {
    await expectReject(
      c,
      'select * from upsert_drink($1,$2,$3,$4)',
      [eventId, null, 'X', 'normale'],
      /solo regia/
    );
    await expectReject(
      c,
      'select * from set_drink_visibility($1,$2)',
      [drinkId, false],
      /solo regia/
    );
    await expectReject(c, 'select * from set_drink_active($1,$2)', [drinkId, false], /solo regia/);
    await expectReject(c, 'select delete_drink($1)', [drinkId], /solo regia/);
  }

  test('cassa_non_basta — tutte e 4 le RPC rifiutate alla cassa', async () => {
    const { eventId, drinkNormale } = await setup();
    await actAs(cassaClaims(), async (c) => {
      await assertAllRejected(c, eventId, drinkNormale);
      // nessun effetto collaterale: il drink resta attivo/visibile com'era nel seed
      const d = (
        await c.query('select visibile, attivo from drinks where id=$1', [drinkNormale])
      ).rows[0];
      assert.equal(d.visibile, true);
      assert.equal(d.attivo, true);
    });
  });

  test('ospite_non_basta — tutte e 4 le RPC rifiutate all\'ospite', async () => {
    const { eventId, drinkNormale } = await setup();
    await actAs(guestClaims(randUuid()), async (c) => {
      await assertAllRejected(c, eventId, drinkNormale);
    });
  });
});

describe('menù — read-scope sotto RLS (visible vs all)', () => {
  // RLS drinks_select: `visibile = true OR is_staff()`. È la semantica che alimenta
  // scope=visible (ospite, solo visibili) vs scope=all (staff, tutto). Il seed ha 1
  // drink normale visibile + 1 premium NASCOSTO (visibile=false).
  test('ospite_non_vede_nascosto — SELECT diretta esclude il drink premium nascosto', async () => {
    const { eventId, drinkNormale, drinkPremium } = await setup();

    await actAs(guestClaims(randUuid()), async (c) => {
      // scope=visible: ciò che vedrebbe l'ospite = where event_id AND visibile
      const rows = (
        await c.query(
          'select id, visibile from drinks where event_id=$1 order by ordine',
          [eventId]
        )
      ).rows;
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(drinkNormale), 'il drink visibile è incluso per l\'ospite');
      assert.ok(
        !ids.includes(drinkPremium),
        'il drink premium nascosto (visibile=false) NON è visibile all\'ospite (RLS)'
      );
      // sanity: ogni riga vista dall'ospite ha visibile=true (la RLS filtra il resto)
      assert.ok(
        rows.every((r) => r.visibile === true),
        'sotto RLS l\'ospite vede SOLO righe visibili'
      );
    });
  });

  test('staff_vede_tutto — la regia (is_staff) vede anche il drink nascosto', async () => {
    const { eventId, drinkNormale, drinkPremium } = await setup();

    await actAs(regiaClaims(randUuid()), async (c) => {
      // scope=all: staff vede ogni voce dell'evento, ordine compreso
      const ids = (
        await c.query('select id from drinks where event_id=$1 order by ordine', [eventId])
      ).rows.map((r) => r.id);
      assert.ok(ids.includes(drinkNormale), 'staff vede il drink visibile');
      assert.ok(
        ids.includes(drinkPremium),
        'staff (is_staff) vede ANCHE il premium nascosto (RLS: visibile OR is_staff)'
      );
    });
  });

  test('cassa_vede_tutto — anche la cassa è is_staff e vede il nascosto', async () => {
    const { eventId, drinkPremium } = await setup();

    await actAs(cassaClaims(), async (c) => {
      const ids = (
        await c.query('select id from drinks where event_id=$1', [eventId])
      ).rows.map((r) => r.id);
      assert.ok(
        ids.includes(drinkPremium),
        'la cassa (is_staff) vede il premium nascosto come la regia'
      );
    });
  });
});
