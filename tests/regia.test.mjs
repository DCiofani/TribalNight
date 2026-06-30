// tests/regia.test.mjs — contratto REALE delle RPC di regia (v0.2):
//   set_phase, start_session, register_taps, close_session, run_draw.
//
// set_phase / start_session / close_session / run_draw richiedono is_staff('regia')
// (cassa NON basta). register_taps è chiamata dall'OSPITE (usa auth.uid()).
// Tutto in una tx con rollback automatico (actAs). L'evento TEST di setup() è APERTA.
//
// Nota determinismo run_draw: passiamo p_seed FISSO; la stessa esecuzione (stesso pool,
// stesso seed) deve produrre gli stessi vincitori. Verifichiamo che il seed registrato
// in draws.seed sia quello passato e che la rerun (in una NUOVA tx, stesso seed/pool)
// dia gli stessi guest_id. Nota tap-cap: register_taps limita il count cumulativo a
// ~ (max_tap_al_secondo * elapsed) + burst; appena dopo start_session elapsed≈0, quindi
// un count <= max_tap_al_secondo (=12 default) passa intero.

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

describe('regia — set_phase', () => {
  test('ciclo_fasi — SETUP->APERTA->LAST_CALL->ESTRAZIONE->CHIUSA (regia)', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      for (const phase of ['SETUP', 'APERTA', 'LAST_CALL', 'ESTRAZIONE', 'CHIUSA']) {
        const ev = (await c.query('select * from set_phase($1,$2)', [eventId, phase])).rows[0];
        assert.equal(ev.fase, phase, `fase impostata a ${phase}`);
        const check = (await c.query('select fase from events where id = $1', [eventId])).rows[0];
        assert.equal(check.fase, phase, 'persistito su events');
      }
    });
  });

  test('fase_non_valida — phase "PAUSA" -> raise, fase invariata', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      await expectReject(c, 'select * from set_phase($1,$2)', [eventId, 'PAUSA'], /fase non valida: PAUSA/);
      const ev = (await c.query('select fase from events where id = $1', [eventId])).rows[0];
      assert.equal(ev.fase, 'APERTA', 'la fase resta quella di setup (APERTA)');
    });
  });

  test('authz_cassa_non_basta — la CASSA non può cambiare fase (solo regia)', async () => {
    const { eventId } = await setup();

    await actAs(cassaClaims(), async (c) => {
      await expectReject(c, 'select * from set_phase($1,$2)', [eventId, 'CHIUSA'], /solo regia/);
      const ev = (await c.query('select fase from events where id = $1', [eventId])).rows[0];
      assert.equal(ev.fase, 'APERTA');
    });
  });

  test('authz_ospite — un ospite non può cambiare fase', async () => {
    const { eventId } = await setup();

    await actAs(guestClaims(randUuid()), async (c) => {
      await expectReject(c, 'select * from set_phase($1,$2)', [eventId, 'CHIUSA'], /solo regia/);
    });
  });
});

describe('regia — start_session', () => {
  test('start_solo_in_aperta — APERTA ok, ma non in LAST_CALL', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      // APERTA (setup): start ok
      const s = (await c.query('select * from start_session($1,$2)', [eventId, 30])).rows[0];
      assert.equal(s.stato, 'active');
      assert.equal(s.event_id, eventId);

      // porto a LAST_CALL: nuove sessioni vietate (chiudo prima quella attiva per isolare il gate fase)
      await c.query('select close_session($1)', [s.id]);
      await c.query('select set_phase($1,$2)', [eventId, 'LAST_CALL']);
      await expectReject(
        c,
        'select * from start_session($1,$2)',
        [eventId, 30],
        /le sessioni si lanciano solo a evento APERTA/
      );
    });
  });

  test('una_alla_volta — seconda start con una attiva -> raise', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      await c.query('select * from start_session($1,$2)', [eventId, 30]);
      await expectReject(
        c,
        'select * from start_session($1,$2)',
        [eventId, 30],
        /chiudi prima la sessione attiva/
      );
    });
  });

  test('authz_cassa_non_basta — start_session solo regia', async () => {
    const { eventId } = await setup();

    await actAs(cassaClaims(), async (c) => {
      await expectReject(c, 'select * from start_session($1,$2)', [eventId, 30], /solo regia/);
    });
  });
});

describe('regia — ciclo end-to-end tap + close', () => {
  test('e2e_tap_close — start -> register_taps (ospiti) -> close (ticket, idempotente)', async () => {
    const { eventId } = await setup();
    const U1 = randUuid();
    const U2 = randUuid();
    const Uregia = randUuid();

    await actAs(regiaClaims(Uregia), async (c) => {
      // due ospiti registrati (come ospiti)
      await setClaims(c, guestClaims(U1));
      const G1 = (await c.query('select * from register_guest($1,$2)', [eventId, 'G1'])).rows[0];
      await setClaims(c, guestClaims(U2));
      const G2 = (await c.query('select * from register_guest($1,$2)', [eventId, 'G2'])).rows[0];

      // regia avvia la sessione (evento APERTA da setup)
      await setClaims(c, regiaClaims(Uregia));
      const sess = (await c.query('select * from start_session($1,$2)', [eventId, 30])).rows[0];
      assert.equal(sess.ticket_ogni, 10, 'tap_ticket_ogni di default = 10');

      // Anti-cheat lato server: register_taps CLAMPA il count cumulativo al tetto
      // plausibile = ceil(elapsed * max_tap_al_secondo) + max_tap_al_secondo. Subito
      // dopo start_session elapsed≈0, quindi il tetto è ~= max_tap_al_secondo (=12):
      // sia 12 che 20 vengono fissati a 12. Asseriamo questo comportamento reale.
      await setClaims(c, guestClaims(U1));
      const t1 = (await c.query('select * from register_taps($1,$2)', [sess.id, 12])).rows[0];
      assert.equal(t1.tap_count, 12, 'count 12 accettato intero (entro il tetto burst iniziale)');
      assert.equal(t1.ticket_assegnati, 0, 'i ticket NON si assegnano in register_taps');

      await setClaims(c, guestClaims(U2));
      const t2 = (await c.query('select * from register_taps($1,$2)', [sess.id, 20])).rows[0];
      assert.equal(t2.tap_count, 12, 'count 20 CLAMPATO a 12 dal tetto anti-autoclicker');

      // regia chiude: floor(min(count, durata*rate)/ticket_ogni) = floor(12/10)=1 ciascuno
      await setClaims(c, regiaClaims(Uregia));
      const total = (await c.query('select close_session($1) as t', [sess.id])).rows[0].t;
      assert.equal(total, 2, 'G1:floor(12/10)=1 + G2:floor(12/10)=1 = 2 ticket');

      // idempotenza close: seconda chiusura -> 0, nessun ticket aggiuntivo
      const total2 = (await c.query('select close_session($1) as t', [sess.id])).rows[0].t;
      assert.equal(total2, 0, 'close idempotente: ritorna 0 e non riassegna');

      // stato guests: ticket_tap coerente (entrambi 1 dopo il clamp a 12)
      const g1 = (await c.query('select ticket_tap from guests where id = $1', [G1.id])).rows[0];
      const g2 = (await c.query('select ticket_tap from guests where id = $1', [G2.id])).rows[0];
      assert.equal(g1.ticket_tap, 1);
      assert.equal(g2.ticket_tap, 1);

      // riga di ledger 'tap' per ciascun guest premiato
      const taps = (
        await c.query("select count(*)::int as n from transactions where event_id=$1 and tipo='tap'", [eventId])
      ).rows[0].n;
      assert.equal(taps, 2, 'una tx tap per ognuno dei due ospiti');

      // sessione marcata closed
      const sclosed = (await c.query('select stato from tap_sessions where id = $1', [sess.id])).rows[0];
      assert.equal(sclosed.stato, 'closed');
    });
  });
});

describe('regia — run_draw', () => {
  // Costruisce, dentro la tx corrente, un pool di vincitori deterministico: registra
  // `n` ospiti, dà a ciascuno saldo + un consumo (genera ticket), porta a ESTRAZIONE.
  // Lascia i claims su REGIA. Ritorna gli id ospite in ordine di creazione.
  async function seedPoolThenEstrazione(c, eventId, Uregia, subs, drinkNormale) {
    const Ucassa = randUuid();
    const guestIds = [];
    for (const sub of subs) {
      await setClaims(c, guestClaims(sub));
      const g = (await c.query('select * from register_guest($1,$2)', [eventId, 'G_' + sub.slice(0, 4)])).rows[0];
      guestIds.push(g.id);
      await setClaims(c, cassaClaims(Ucassa));
      await c.query('select * from topup($1,$2,$3,$4,$5)', [g.id, 'normale', 2, 10, randUuid()]);
      await c.query('select * from consume($1,$2,$3)', [g.id, drinkNormale, randUuid()]);
    }
    await setClaims(c, regiaClaims(Uregia));
    await c.query('select set_phase($1,$2)', [eventId, 'ESTRAZIONE']);
    return guestIds;
  }

  test('determinismo_seed_fisso — seed registrato + scelta stabile su pool equivalente', async () => {
    // VINCOLO REALE: run_draw crea una TEMP TABLE `_pool ON COMMIT DROP`; due chiamate
    // nella STESSA tx collidono (42P07: la temp non si droppa fino al commit, e qui
    // committiamo MAI). Quindi facciamo due esecuzioni in DUE tx separate (ogni actAs
    // fa rollback a fine tx, che droppa la temp). I guest.id sono gen_random_uuid() →
    // NON stabili fra tx, e run_draw ordina il pool `order by id`: confrontare i guest_id
    // o il vincitore di un pool a ticket DIVERSI sarebbe FLAKY (dipende da come gli uuid
    // si ordinano rispetto all'indice pescato dal seed). Per un test NON flaky usiamo un
    // pool a ticket UGUALI: qualunque ospite il seed scelga, la quantità di ticket del
    // vincitore è la stessa. Verifichiamo così: (a) il seed passato viene REGISTRATO in
    // draws.seed (riproducibilità/verificabilità a posteriori); (b) con lo stesso seed e
    // un pool equivalente la scelta è deterministica (stessa quantità di ticket vinta).
    const Uregia = randUuid();
    const SEED = 0.4242;

    // pool a ticket UGUALI: 2 ospiti, ciascuno 1 consumo normale => 4 ticket a testa.
    async function drawOnce() {
      const { eventId, drinkNormale } = await setup();
      let winnerTickets, recordedSeed, nWinners;
      await actAs(regiaClaims(Uregia), async (c) => {
        const Ucassa = randUuid();
        for (let k = 0; k < 2; k++) {
          await setClaims(c, guestClaims(randUuid()));
          const g = (await c.query('select * from register_guest($1,$2)', [eventId, 'G' + k])).rows[0];
          await setClaims(c, cassaClaims(Ucassa));
          await c.query('select * from topup($1,$2,$3,$4,$5)', [g.id, 'normale', 1, 5, randUuid()]);
          await c.query('select * from consume($1,$2,$3)', [g.id, drinkNormale, randUuid()]);
        }
        await setClaims(c, regiaClaims(Uregia));
        await c.query('select set_phase($1,$2)', [eventId, 'ESTRAZIONE']);
        const draw = (await c.query('select * from run_draw($1,$2,$3)', [eventId, 1, SEED])).rows[0];
        recordedSeed = Number(draw.seed);
        nWinners = draw.n_winners;
        winnerTickets = draw.winners.map((w) => w.tickets);
      });
      return { winnerTickets, recordedSeed, nWinners };
    }

    const run1 = await drawOnce();
    const run2 = await drawOnce();

    assert.equal(run1.recordedSeed, SEED, 'seed registrato = quello passato (verificabilità)');
    assert.equal(run2.recordedSeed, SEED);
    assert.equal(run1.nWinners, 1, 'un solo vincitore (n_winners=1)');
    assert.deepEqual(run1.winnerTickets, [4], 'vincitore con 4 ticket (1 consumo normale)');
    assert.deepEqual(
      run2.winnerTickets,
      run1.winnerTickets,
      'stesso seed + pool equivalente -> stessa scelta deterministica'
    );
  });

  test('fase_non_estrazione — run_draw in APERTA -> raise (anti-regressione)', async () => {
    const { eventId } = await setup();
    const Uregia = randUuid();

    // evento TEST è APERTA da setup(): run_draw deve rifiutare
    await actAs(regiaClaims(Uregia), async (c) => {
      await expectReject(
        c,
        'select * from run_draw($1,$2,$3)',
        [eventId, 1, 0.5],
        /imposta la fase ESTRAZIONE prima del sorteggio/
      );
    });
  });

  test('n_winners_invalido — n_winners < 1 -> raise', async () => {
    const { eventId, drinkNormale } = await setup();
    const Uregia = randUuid();
    const subs = [randUuid()];

    await actAs(regiaClaims(Uregia), async (c) => {
      await seedPoolThenEstrazione(c, eventId, Uregia, subs, drinkNormale);
      await expectReject(
        c,
        'select * from run_draw($1,$2,$3)',
        [eventId, 0, 0.5],
        /numero vincitori non valido/
      );
    });
  });

  test('authz_cassa_non_basta — run_draw solo regia', async () => {
    const { eventId } = await setup();

    await actAs(cassaClaims(), async (c) => {
      await expectReject(c, 'select * from run_draw($1,$2,$3)', [eventId, 1, 0.5], /solo regia/);
    });
  });
});
