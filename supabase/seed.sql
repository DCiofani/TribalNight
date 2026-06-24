-- Seed SOLO per dev/staging (NON in produzione). Crea un evento APERTA + un listino base.
-- Rieseguibile: non duplica l'evento di test (guard su nome).
do $$
declare v_event uuid;
begin
  select id into v_event from public.events where nome = 'Totem Night — DEV' limit 1;
  if v_event is null then
    insert into public.events (nome, fase) values ('Totem Night — DEV', 'APERTA')
    returning id into v_event;

    insert into public.drinks (event_id, nome, tipo, categoria, ordine) values
      (v_event, 'Birra',      'normale', 'Birre',      1),
      (v_event, 'Calice',     'normale', 'Vini',       2),
      (v_event, 'Analcolico', 'normale', 'Analcolici', 3),
      (v_event, 'Cocktail',   'premium', 'Cocktail',   4),
      (v_event, 'Distillato', 'premium', 'Distillati', 5);
  end if;
end $$;
