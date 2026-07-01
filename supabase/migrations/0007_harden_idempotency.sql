-- ============================================================================
-- 0007 — Hardening idempotenza/concorrenza (findings load-test).
-- La CORRETTEZZA reggeva già (invarianti mai violate: no doppio-saldo, no
-- oversell, PIN unici via constraint). Questo fix elimina i 500 grezzi sotto
-- concorrenza estrema, rendendo il ramo idempotente sempre pulito (200).
--   1) topup: retry concorrenti con lo STESSO p_idem collidevano su
--      transactions_pkey → 500. Ora: re-check idem post-lock + handler
--      unique_violation che ROLLA indietro l'update del saldo e RITORNA la tx
--      già scritta.
--   2) register_guest: pre-check PIN ('not exists') non atomico + INSERT senza
--      handler → una collisione PIN concorrente poteva sollevare unique_violation
--      non ritentata. Ora: INSERT in blocco con retry su collisione PIN e
--      idempotenza su registrazione concorrente dello stesso auth_uid.
-- Solo create-or-replace: nessuna modifica a tabelle/policy. Ri-applicabile.
-- ============================================================================

-- ── register_guest (retry atomico su unique_violation) ─────────────────────
create or replace function public.register_guest(p_event uuid, p_nome text)
returns public.guests
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.guests;
  v_pin text;
  v_try int := 0;
begin
  if v_uid is null then
    raise exception 'autenticazione richiesta';
  end if;

  select * into v_row from public.guests
   where event_id = p_event and auth_uid = v_uid;
  if found then
    return v_row;                       -- già registrato: idempotente (fast-path)
  end if;

  loop
    v_try := v_try + 1;
    if v_try <= 50 then
      v_pin := lpad((floor(random() * 10000))::int::text, 4, '0');     -- 4 cifre
    else
      v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');   -- fallback 6 cifre
    end if;

    begin
      insert into public.guests (event_id, auth_uid, nome, pin, consenso_tos_at, last_seen)
      values (
        p_event, v_uid,
        coalesce(nullif(trim(p_nome), ''), 'Ospite'),
        v_pin, now(), now()
      )
      returning * into v_row;
      return v_row;                     -- successo
    exception when unique_violation then
      -- Collisione: se è una registrazione concorrente dello STESSO utente,
      -- ritorna quella (idempotenza); altrimenti è collisione PIN → ritenta.
      select * into v_row from public.guests
       where event_id = p_event and auth_uid = v_uid;
      if found then
        return v_row;
      end if;
      if v_try >= 100 then
        raise exception 'impossibile generare un PIN univoco per l''evento';
      end if;
      -- loop: nuovo PIN
    end;
  end loop;
end;
$$;

-- ── topup (re-check idem post-lock + handler unique_violation) ──────────────
create or replace function public.topup(
  p_guest uuid, p_tipo text, p_qta int, p_importo numeric, p_idem uuid
) returns public.transactions
language plpgsql security definer set search_path = public
as $$
declare
  v_ev public.events;
  v_g  public.guests;
  v_tx public.transactions;
begin
  if not public.is_staff() then
    raise exception 'operazione riservata allo staff (cassa/regia)';
  end if;
  if p_tipo not in ('normale','premium') then
    raise exception 'tipo consumazione non valido: %', p_tipo;
  end if;
  if p_qta is null or p_qta <= 0 then
    raise exception 'quantità non valida';
  end if;

  select * into v_tx from public.transactions where id = p_idem;
  if found then
    return v_tx;                        -- idempotenza (fast-path)
  end if;

  select * into v_g from public.guests where id = p_guest for update;
  if not found then raise exception 'ospite inesistente'; end if;

  -- Re-check DOPO il lock: serializzati sullo stesso ospite, un retry concorrente
  -- con lo stesso idem trova qui la tx già scritta e la ritorna senza mutare.
  select * into v_tx from public.transactions where id = p_idem;
  if found then
    return v_tx;
  end if;

  select * into v_ev from public.events where id = v_g.event_id;
  if v_ev.fase <> 'APERTA' then
    raise exception 'ricariche disabilitate nella fase %', v_ev.fase;
  end if;

  -- Backstop: se un retry concorrente inserisce lo stesso p_idem tra il re-check
  -- e l'INSERT, la unique_violation rolla indietro l'update del saldo e ritorna
  -- la tx esistente (200 pulito, mai doppio credito).
  begin
    if p_tipo = 'normale' then
      update public.guests set saldo_normale = saldo_normale + p_qta where id = p_guest;
    else
      update public.guests set saldo_premium = saldo_premium + p_qta where id = p_guest;
    end if;

    insert into public.transactions
      (id, event_id, guest_id, tipo, tipo_consumazione, qta_delta, ticket_delta, importo_euro, operatore)
    values
      (p_idem, v_g.event_id, p_guest, 'ricarica', p_tipo, p_qta, 0, p_importo, auth.uid())
    returning * into v_tx;

    return v_tx;
  exception when unique_violation then
    select * into v_tx from public.transactions where id = p_idem;
    return v_tx;
  end;
end;
$$;
