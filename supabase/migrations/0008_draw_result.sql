-- ============================================================================
-- 0008 — Esito estrazione GUEST-SAFE (reveal ospite).
--
-- Problema: la RLS su public.draws è STAFF-ONLY (0002_draws_select_staff:
-- draws_select = is_staff()). L'ospite NON può leggere `draws` direttamente,
-- quindi non può sapere se è stato estratto/ha vinto. run_draw (0001 §4.9)
-- scrive draws.winners come jsonb array di oggetti { pos, guest_id, nome,
-- tickets } (uno per vincitore) e pool_snapshot come [{guest_id, nome,
-- tickets}, ...]. draws.created_at data la riga.
--
-- Soluzione: RPC SECURITY DEFINER che ritorna SOLO l'esito del chiamante,
-- senza mai esporre i dati di altri ospiti (né nomi, né elenco vincitori).
-- L'ospite chiamante è risolto via auth.uid() sulla riga guests dell'evento;
-- l'esito è calcolato sull'ULTIMA draws dell'evento (order by created_at desc).
--
-- Contratto (una riga):
--   estratto boolean — esiste (almeno) una draws per l'evento (sorteggio fatto)
--   vinto    boolean — il guest_id del chiamante è tra draws.winners[*].guest_id
--   premio   text    — se vinto: etichetta posizione (es. "1° posto"); altrimenti null
--
-- Solo create-or-replace: nessuna modifica a tabelle/policy. Ri-applicabile.
-- ============================================================================

create or replace function public.my_draw_result(p_event uuid)
returns table(estratto boolean, vinto boolean, premio text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_guest   uuid;                       -- guest.id del chiamante per questo evento
  v_winners jsonb;                      -- draws.winners dell'ultima estrazione
  v_win     jsonb;                      -- oggetto vincitore del chiamante (se presente)
begin
  -- Chiamante non autenticato o non registrato a questo evento → nessun esito.
  if v_uid is null then
    return query select false, false, null::text;
    return;
  end if;

  select g.id into v_guest
    from public.guests g
   where g.event_id = p_event
     and g.auth_uid = v_uid;

  if v_guest is null then
    return query select false, false, null::text;
    return;
  end if;

  -- ULTIMA estrazione dell'evento (una per evento nella pratica; limit 1 per robustezza).
  select d.winners into v_winners
    from public.draws d
   where d.event_id = p_event
   order by d.created_at desc
   limit 1;

  -- Nessuna draws per l'evento → non ancora estratto (l'ospite vede "in attesa").
  if v_winners is null then
    return query select false, false, null::text;
    return;
  end if;

  -- estratto = il sorteggio è avvenuto. Cerca l'oggetto vincitore del chiamante:
  -- winners = [{ pos, guest_id, nome, tickets }, ...]; match sul solo guest_id
  -- (non esponiamo nome/tickets/pos degli ALTRI vincitori).
  select w into v_win
    from jsonb_array_elements(v_winners) as w
   where (w->>'guest_id')::uuid = v_guest
   limit 1;

  if v_win is null then
    -- Estratto ma non vincitore.
    return query select true, false, null::text;
    return;
  end if;

  -- Vincitore: premio = etichetta derivata dalla posizione (pos) se presente,
  -- altrimenti placeholder. Nessun dato di altri ospiti nel valore ritornato.
  return query
    select
      true,
      true,
      case
        when (v_win->>'pos') is not null then (v_win->>'pos') || '° posto'
        else 'Premio'
      end::text;
end;
$$;

grant execute on function public.my_draw_result(uuid) to authenticated;
