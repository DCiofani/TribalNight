-- Asserzioni post-migrazione: il contratto v0.2 è presente e blindato.
-- Verifica: 14 RPC + current_event() (firma esatta) + grant execute ad authenticated,
-- assenza della firma v0.1 di register_taps, unique(event_id,pin), RLS abilitata,
-- e default-deny (nessuna policy di scrittura). Fallisce con ON_ERROR_STOP se qualcosa manca.
do $$
declare
  rpc text;
  rpcs text[] := array[
    'public.current_event()',
    'public.register_guest(uuid,text)',
    'public.topup(uuid,text,int,numeric,uuid)',
    'public.consume(uuid,uuid,uuid)',
    'public.convert_credit(uuid,uuid)',
    'public.set_phase(uuid,text)',
    'public.start_session(uuid,int)',
    'public.register_taps(uuid,int)',
    'public.close_session(uuid)',
    'public.run_draw(uuid,int,double precision)',
    'public.update_event_settings(uuid,numeric,numeric,int,int,int,int,int,int,int)',
    'public.upsert_drink(uuid,uuid,text,text,text,text,text,int,boolean,boolean)',
    'public.set_drink_visibility(uuid,boolean)',
    'public.set_drink_active(uuid,boolean)',
    'public.delete_drink(uuid)',
    'public.event_stats(uuid)'
  ];
begin
  foreach rpc in array rpcs loop
    if to_regprocedure(rpc) is null then
      raise exception 'RPC mancante o firma errata: %', rpc;
    end if;
    if not has_function_privilege('authenticated', to_regprocedure(rpc), 'execute') then
      raise exception 'grant execute mancante per authenticated: %', rpc;
    end if;
  end loop;

  -- drift: la firma v0.1 di register_taps non deve esistere
  if to_regprocedure('public.register_taps(uuid,int,int)') is not null then
    raise exception 'register_taps v0.1 (uuid,int,int) ancora presente: drift di contratto';
  end if;

  -- PIN univoco per evento (OQ8)
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.guests'::regclass and contype = 'u'
       and pg_get_constraintdef(oid) ilike '%(event_id, pin)%'
  ) then
    raise exception 'manca unique(event_id, pin) su guests (OQ8)';
  end if;

  -- RLS abilitata su tutte e 7 le tabelle
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) < 7 then
    raise exception 'RLS non abilitata su tutte le tabelle attese';
  end if;

  -- default-deny: SOLO policy SELECT (le scritture passano esclusivamente dagli RPC)
  if exists (select 1 from pg_policies where schemaname = 'public' and cmd <> 'SELECT') then
    raise exception 'trovata policy non-SELECT: default-deny violato (scritture solo via RPC)';
  end if;

  raise notice 'OK: contratto v0.2 — 14 RPC + current_event + grants + unique pin + RLS default-deny.';
end $$;
