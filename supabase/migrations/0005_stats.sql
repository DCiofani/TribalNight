-- ============================================================================
-- TOTEM NIGHT — Migrazione 0005: RPC aggregata public.event_stats(p_event)
-- ----------------------------------------------------------------------------
-- Statistiche server-authoritative per la dashboard di regia. Il front-end NON
-- calcola mai conteggi: ogni numero arriva da qui.
--   * fase             = events.fase dell'evento
--   * presenze         = numero di ospiti registrati per l'evento (count guests)
--   * gettoni_venduti  = somma delle consumazioni vendute via ricarica
--                        (transactions.tipo = 'ricarica', qta_delta è +consumazioni)
--   * ticket_totali    = somma di guests.ticket_totali (colonna GENERATED stored)
-- Stile copiato dalle RPC di 0001: SECURITY DEFINER, set search_path = public,
-- gate is_staff() con errcode P0001. Idempotente (create or replace).
-- ============================================================================

create or replace function public.event_stats(p_event uuid)
returns table(
  fase            text,
  presenze        int,
  gettoni_venduti int,
  ticket_totali   int
)
language plpgsql security definer set search_path = public
as $$
begin
  if not is_staff() then
    raise exception 'operazione riservata allo staff' using errcode = 'P0001';
  end if;

  return query
    select
      e.fase,
      (select count(*)::int from guests g where g.event_id = p_event),
      coalesce(
        (select sum(t.qta_delta) from transactions t
          where t.event_id = p_event and t.tipo = 'ricarica'),
        0)::int,
      coalesce(
        (select sum(g.ticket_totali) from guests g where g.event_id = p_event),
        0)::int
    from events e
    where e.id = p_event;
end;
$$;

grant execute on function public.event_stats(uuid) to authenticated;
