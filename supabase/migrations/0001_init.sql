-- ============================================================================
-- TOTEM NIGHT — Schema dati Supabase / PostgreSQL
-- Step 1: tabelle + funzioni server-authoritative (RPC) + RLS + grants + seed
-- Versione 0.2 — applicare come singola migrazione (psql -f) su Supabase.
-- v0.2 (hardening OQ): PIN univoco per evento + QR su guest.id come ID primario;
--   register_taps idempotente (count cumulativo, validazione tempo lato server);
--   helper current_event() (deploy a evento singolo); note sicurezza realtime sul PIN.
-- ----------------------------------------------------------------------------
-- MODELLO AUTH (assunzioni):
--   * Ospite  -> Supabase "anonymous sign-in": ha un auth.uid(); 1 riga in guests.
--   * Staff   -> account Supabase con claim app_metadata.role IN ('cassa','regia','admin').
--               (impostare il claim via Admin API / dashboard; 'admin' = super-staff).
-- REGOLA D'ORO: saldi e ticket si muovono SOLO tramite le funzioni RPC qui sotto
--   (SECURITY DEFINER). Le tabelle non concedono INSERT/UPDATE/DELETE diretti:
--   la RLS lascia ai client solo la SELECT dei dati che li riguardano.
-- Tutti i numeri (prezzi, ticket, durate, anti-cheat) vivono nella tabella events.
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- 1) FUNZIONI HELPER (ruoli / livello totem)
-- ----------------------------------------------------------------------------

-- Ruolo applicativo del chiamante, letto dal claim JWT app_metadata.role.
create or replace function public.app_role()
returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb
      -> 'app_metadata' ->> 'role',
    'guest'
  );
$$;

-- È staff? Se p_role è NULL -> qualunque staff. 'admin' passa sempre.
create or replace function public.is_staff(p_role text default null)
returns boolean
language sql stable
as $$
  select case
    when public.app_role() = 'admin' then true
    when p_role is null then public.app_role() in ('cassa','regia')
    else public.app_role() = p_role
  end;
$$;

-- Livello visivo del totem in funzione del numero di consumazioni.
create or replace function public.totem_level(p_count int)
returns int
language sql immutable
as $$
  select case
    when p_count >= 20 then 6
    when p_count >= 12 then 5
    when p_count >= 8  then 4
    when p_count >= 5  then 3
    when p_count >= 2  then 2
    when p_count >= 1  then 1
    else 0
  end;
$$;

-- ----------------------------------------------------------------------------
-- 2) TABELLE
-- ----------------------------------------------------------------------------

-- Evento + tutti i parametri configurabili della serata.
create table if not exists public.events (
  id                          uuid primary key default gen_random_uuid(),
  nome                        text not null,
  fase                        text not null default 'SETUP'
                                check (fase in ('SETUP','APERTA','LAST_CALL','ESTRAZIONE','CHIUSA')),
  -- prezzi (in euro) di una consumazione di ciascun tipo
  prezzo_normale              numeric(8,2) not null default 5,
  prezzo_premium              numeric(8,2) not null default 8,
  -- ticket assegnati al CONSUMO (la premium vale di più)
  ticket_consumo_normale      int not null default 4,
  ticket_consumo_premium      int not null default 8,
  -- ticket assegnati alla CONVERSIONE finale (leggermente > del consumo)
  ticket_conversione_normale  int not null default 5,
  ticket_conversione_premium  int not null default 10,
  -- sessioni di tap
  tap_ticket_ogni             int not null default 10 check (tap_ticket_ogni > 0),
  durata_sessione_s           int not null default 30 check (durata_sessione_s > 0),
  max_tap_al_secondo          int not null default 12 check (max_tap_al_secondo > 0),
  created_at                  timestamptz not null default now()
);

-- Ospite = "utente digitale". I saldi sono DUE e separati (non intercambiabili).
create table if not exists public.guests (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references public.events(id) on delete cascade,
  auth_uid            uuid unique,                 -- mappa all'utente Supabase
  nome                text not null,
  pin                 text not null,               -- fallback leggibile; l'ID primario alla cassa è guest.id (QR). NON broadcastare nei realtime verso altri
  consenso_tos_at     timestamptz,                 -- accettazione T&C
  saldo_normale       int not null default 0 check (saldo_normale >= 0),
  saldo_premium       int not null default 0 check (saldo_premium >= 0),
  ticket_consumo      int not null default 0 check (ticket_consumo >= 0),
  ticket_tap          int not null default 0 check (ticket_tap >= 0),
  ticket_conversione  int not null default 0 check (ticket_conversione >= 0),
  ticket_totali       int generated always as
                        (ticket_consumo + ticket_tap + ticket_conversione) stored,
  consumazioni_count  int not null default 0 check (consumazioni_count >= 0),
  livello_totem       int not null default 0,
  created_at          timestamptz not null default now(),
  last_seen           timestamptz,
  unique (event_id, auth_uid),
  unique (event_id, pin)               -- PIN univoco per evento (vedi register_guest)
);

-- Listino / MENÙ consultabile: ogni drink consuma 1 unità del saldo del proprio tipo.
create table if not exists public.drinks (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  nome          text not null,
  tipo          text not null check (tipo in ('normale','premium')),
  descrizione   text,                                -- testo per il menù
  categoria     text,                                -- es. Cocktail, Birre, Analcolici
  immagine_url  text,
  ordine        int not null default 0,              -- ordinamento nel menù
  visibile      boolean not null default true,       -- mostrato nel menù dell'ospite
  attivo        boolean not null default true,       -- ordinabile alla cassa
  created_at    timestamptz not null default now()
);

-- Ledger append-only: ricariche, consumi, conversioni, ticket da tap.
create table if not exists public.transactions (
  id                  uuid primary key,            -- idempotency key (fornita dal client)
  event_id            uuid not null references public.events(id) on delete cascade,
  guest_id            uuid not null references public.guests(id) on delete cascade,
  tipo                text not null check (tipo in ('ricarica','consumo','conversione','tap')),
  tipo_consumazione   text check (tipo_consumazione in ('normale','premium')),
  qta_delta           int not null default 0,      -- variazione consumazioni (+ ricarica, - consumo)
  ticket_delta        int not null default 0,
  importo_euro        numeric(8,2),                -- per la riconciliazione cassa (solo ricarica)
  operatore           uuid,                        -- auth.uid() di cassa/regia (null se ospite)
  note                text,
  created_at          timestamptz not null default now()
);

-- Sessione di tap (finestra a tempo lanciata dalla regia).
create table if not exists public.tap_sessions (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references public.events(id) on delete cascade,
  stato               text not null default 'active' check (stato in ('active','closed')),
  durata_s            int not null,
  ticket_ogni         int not null,
  max_tap_al_secondo  int not null,
  started_at          timestamptz not null default now(),
  ends_at             timestamptz not null,
  closed_at           timestamptz
);

-- Conteggio tap aggregato per (sessione, ospite).
create table if not exists public.taps (
  session_id        uuid not null references public.tap_sessions(id) on delete cascade,
  guest_id          uuid not null references public.guests(id) on delete cascade,
  tap_count         int not null default 0 check (tap_count >= 0),
  ticket_assegnati  int not null default 0 check (ticket_assegnati >= 0),
  updated_at        timestamptz not null default now(),
  primary key (session_id, guest_id)
);

-- Estrazione: seed + snapshot del pool => verificabile a posteriori.
create table if not exists public.draws (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  seed           double precision not null,
  n_winners      int not null,
  pool_snapshot  jsonb not null,    -- [{guest_id, nome, tickets}, ...] ordinato per id
  winners        jsonb not null,    -- [{pos, guest_id, nome, tickets}, ...]
  created_at     timestamptz not null default now()
);

create index if not exists idx_guests_event   on public.guests(event_id);
create index if not exists idx_tx_guest        on public.transactions(guest_id);
create index if not exists idx_tx_event        on public.transactions(event_id);
create index if not exists idx_taps_session    on public.taps(session_id);
create index if not exists idx_drinks_event    on public.drinks(event_id);
create index if not exists idx_sessions_event  on public.tap_sessions(event_id);

-- ----------------------------------------------------------------------------
-- 3) ROW LEVEL SECURITY
--    Default deny. Concediamo solo SELECT mirate; le scritture passano dagli RPC.
-- ----------------------------------------------------------------------------

alter table public.events       enable row level security;
alter table public.guests       enable row level security;
alter table public.drinks       enable row level security;
alter table public.transactions enable row level security;
alter table public.tap_sessions enable row level security;
alter table public.taps         enable row level security;
alter table public.draws        enable row level security;

-- events / drinks / tap_sessions / draws: lettura per ogni autenticato.
create policy events_select   on public.events       for select to authenticated using (true);
-- menù: l'ospite vede solo le voci visibili; lo staff vede tutto.
create policy drinks_select   on public.drinks       for select to authenticated
  using (visibile = true or public.is_staff());
create policy sessions_select on public.tap_sessions for select to authenticated using (true);
create policy draws_select    on public.draws        for select to authenticated using (true);

-- guests: l'ospite vede sé stesso; lo staff vede tutti.
create policy guests_select on public.guests for select to authenticated
  using (auth_uid = auth.uid() or public.is_staff());

-- transactions: l'ospite vede le proprie; lo staff tutte.
create policy tx_select on public.transactions for select to authenticated
  using (
    public.is_staff()
    or guest_id in (select g.id from public.guests g where g.auth_uid = auth.uid())
  );

-- taps: l'ospite vede i propri; lo staff tutti.
create policy taps_select on public.taps for select to authenticated
  using (
    public.is_staff()
    or guest_id in (select g.id from public.guests g where g.auth_uid = auth.uid())
  );

-- Nessuna policy di INSERT/UPDATE/DELETE: le scritture dirette sono negate.

-- ----------------------------------------------------------------------------
-- 4) FUNZIONI RPC (server-authoritative, SECURITY DEFINER)
--    Ogni funzione verifica autorizzazione e fase prima di toccare i saldi.
-- ----------------------------------------------------------------------------

-- 4.0 Evento attivo corrente (deploy a evento singolo: il client non deve passare event_id).
create or replace function public.current_event()
returns uuid
language sql stable
as $$
  select id from public.events
   where fase <> 'CHIUSA'
   order by case fase
              when 'APERTA' then 0 when 'LAST_CALL' then 1
              when 'ESTRAZIONE' then 2 when 'SETUP' then 3 else 4 end,
            created_at desc
   limit 1;
$$;

-- 4.1 Onboarding ospite (chiamata dall'ospite dopo l'anonymous sign-in). Idempotente.
--     PIN univoco per evento (retry su collisione); l'ID primario alla cassa è guest.id (QR).
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
    return v_row;                       -- già registrato: idempotente
  end if;

  -- genera un PIN univoco per l'evento (l'unique constraint è la garanzia finale)
  loop
    v_try := v_try + 1;
    v_pin := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (
      select 1 from public.guests where event_id = p_event and pin = v_pin
    );
    if v_try >= 50 then
      v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');  -- fallback 6 cifre
      exit;
    end if;
  end loop;

  insert into public.guests (event_id, auth_uid, nome, pin, consenso_tos_at, last_seen)
  values (
    p_event, v_uid,
    coalesce(nullif(trim(p_nome), ''), 'Ospite'),
    v_pin, now(), now()
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- 4.2 Ricarica: denaro reale -> +consumazioni del tipo scelto (solo fase APERTA).
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
    return v_tx;                        -- idempotenza su retry di rete
  end if;

  select * into v_g from public.guests where id = p_guest for update;
  if not found then raise exception 'ospite inesistente'; end if;

  select * into v_ev from public.events where id = v_g.event_id;
  if v_ev.fase <> 'APERTA' then
    raise exception 'ricariche disabilitate nella fase %', v_ev.fase;
  end if;

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
end;
$$;

-- 4.3 Consumo al bar: -1 dal saldo del tipo del drink, +ticket, totem cresce.
create or replace function public.consume(p_guest uuid, p_drink uuid, p_idem uuid)
returns public.transactions
language plpgsql security definer set search_path = public
as $$
declare
  v_ev public.events;
  v_g  public.guests;
  v_d  public.drinks;
  v_tx public.transactions;
  v_tickets int;
begin
  if not public.is_staff() then
    raise exception 'operazione riservata allo staff (cassa/regia)';
  end if;

  select * into v_tx from public.transactions where id = p_idem;
  if found then return v_tx; end if;     -- idempotenza

  select * into v_g from public.guests where id = p_guest for update;
  if not found then raise exception 'ospite inesistente'; end if;

  select * into v_ev from public.events where id = v_g.event_id;
  if v_ev.fase <> 'APERTA' then
    raise exception 'bar non operativo nella fase %', v_ev.fase;
  end if;

  select * into v_d from public.drinks
   where id = p_drink and event_id = v_g.event_id and attivo;
  if not found then raise exception 'drink non valido o non attivo'; end if;

  if v_d.tipo = 'normale' then
    if v_g.saldo_normale < 1 then raise exception 'saldo NORMALE insufficiente'; end if;
    v_tickets := v_ev.ticket_consumo_normale;
    update public.guests set
      saldo_normale      = saldo_normale - 1,
      ticket_consumo     = ticket_consumo + v_tickets,
      consumazioni_count = consumazioni_count + 1,
      livello_totem      = public.totem_level(consumazioni_count + 1)
    where id = p_guest;
  else
    if v_g.saldo_premium < 1 then raise exception 'saldo PREMIUM insufficiente'; end if;
    v_tickets := v_ev.ticket_consumo_premium;
    update public.guests set
      saldo_premium      = saldo_premium - 1,
      ticket_consumo     = ticket_consumo + v_tickets,
      consumazioni_count = consumazioni_count + 1,
      livello_totem      = public.totem_level(consumazioni_count + 1)
    where id = p_guest;
  end if;

  insert into public.transactions
    (id, event_id, guest_id, tipo, tipo_consumazione, qta_delta, ticket_delta, operatore, note)
  values
    (p_idem, v_g.event_id, p_guest, 'consumo', v_d.tipo, -1, v_tickets, auth.uid(), v_d.nome)
  returning * into v_tx;

  return v_tx;
end;
$$;

-- 4.4 Conversione finale (solo fase LAST_CALL): credito residuo -> ticket. Una sola volta.
--     Avviabile dall'ospite stesso o dallo staff. IRREVERSIBILE.
create or replace function public.convert_credit(p_guest uuid, p_idem uuid)
returns public.guests
language plpgsql security definer set search_path = public
as $$
declare
  v_ev public.events;
  v_g  public.guests;
  v_norm int;
  v_prem int;
  v_tickets int;
begin
  select * into v_g from public.guests where id = p_guest for update;
  if not found then raise exception 'ospite inesistente'; end if;

  if not (public.is_staff() or v_g.auth_uid = auth.uid()) then
    raise exception 'non autorizzato';
  end if;

  select * into v_ev from public.events where id = v_g.event_id;
  if v_ev.fase <> 'LAST_CALL' then
    raise exception 'conversione disponibile solo nel LAST_CALL (fase attuale: %)', v_ev.fase;
  end if;

  -- idempotenza: una conversione per ospite
  if exists (select 1 from public.transactions
              where guest_id = p_guest and tipo = 'conversione') then
    return v_g;
  end if;

  v_norm := v_g.saldo_normale;
  v_prem := v_g.saldo_premium;
  if (v_norm + v_prem) = 0 then
    raise exception 'nessun credito da convertire';
  end if;

  v_tickets := v_norm * v_ev.ticket_conversione_normale
             + v_prem * v_ev.ticket_conversione_premium;

  update public.guests set
    saldo_normale      = 0,
    saldo_premium      = 0,
    ticket_conversione = ticket_conversione + v_tickets
  where id = p_guest
  returning * into v_g;

  insert into public.transactions
    (id, event_id, guest_id, tipo, tipo_consumazione, qta_delta, ticket_delta, operatore, note)
  values
    (p_idem, v_g.event_id, p_guest, 'conversione', null,
     -(v_norm + v_prem), v_tickets, auth.uid(),
     format('convertite norm:%s prem:%s', v_norm, v_prem));

  return v_g;
end;
$$;

-- 4.5 Cambio fase (solo regia).
create or replace function public.set_phase(p_event uuid, p_phase text)
returns public.events
language plpgsql security definer set search_path = public
as $$
declare v_ev public.events;
begin
  if not public.is_staff('regia') then raise exception 'solo regia'; end if;
  if p_phase not in ('SETUP','APERTA','LAST_CALL','ESTRAZIONE','CHIUSA') then
    raise exception 'fase non valida: %', p_phase;
  end if;
  update public.events set fase = p_phase where id = p_event returning * into v_ev;
  if not found then raise exception 'evento inesistente'; end if;
  return v_ev;
end;
$$;

-- 4.6 Avvio sessione di tap (solo regia, solo fase APERTA, una alla volta).
create or replace function public.start_session(p_event uuid, p_durata int default null)
returns public.tap_sessions
language plpgsql security definer set search_path = public
as $$
declare
  v_ev public.events;
  v_s  public.tap_sessions;
  v_dur int;
begin
  if not public.is_staff('regia') then raise exception 'solo regia'; end if;

  select * into v_ev from public.events where id = p_event;
  if not found then raise exception 'evento inesistente'; end if;
  if v_ev.fase <> 'APERTA' then
    raise exception 'le sessioni si lanciano solo a evento APERTA';
  end if;
  if exists (select 1 from public.tap_sessions
              where event_id = p_event and stato = 'active') then
    raise exception 'chiudi prima la sessione attiva (close_session)';
  end if;

  v_dur := coalesce(p_durata, v_ev.durata_sessione_s);

  insert into public.tap_sessions
    (event_id, stato, durata_s, ticket_ogni, max_tap_al_secondo, started_at, ends_at)
  values
    (p_event, 'active', v_dur, v_ev.tap_ticket_ogni, v_ev.max_tap_al_secondo,
     now(), now() + make_interval(secs => v_dur))
  returning * into v_s;

  return v_s;
end;
$$;

-- 4.7 Registrazione tap (chiamata dall'ospite). Idempotente e anti-autoclicker.
--     p_count = conteggio CUMULATIVO della sessione dichiarato dal client (non un delta).
--     I ticket NON vengono assegnati qui: solo al close_session.
create or replace function public.register_taps(p_session uuid, p_count int)
returns public.taps
language plpgsql security definer set search_path = public
as $$
declare
  v_s   public.tap_sessions;
  v_g   public.guests;
  v_uid uuid := auth.uid();
  v_elapsed numeric;
  v_allow int;
  v_cap   int;
  v_row public.taps;
begin
  if v_uid is null then raise exception 'autenticazione richiesta'; end if;
  if p_count is null or p_count < 0 then raise exception 'count non valido'; end if;

  select * into v_s from public.tap_sessions where id = p_session;
  if not found then raise exception 'sessione inesistente'; end if;
  if v_s.stato <> 'active' or now() > v_s.ends_at then
    raise exception 'sessione non attiva';
  end if;

  select * into v_g from public.guests
   where auth_uid = v_uid and event_id = v_s.event_id;
  if not found then raise exception 'ospite non registrato per questo evento'; end if;

  -- tetto plausibile lato SERVER (niente fiducia nel client): rate * secondi trascorsi + 1s di burst
  v_elapsed := greatest(extract(epoch from (now() - v_s.started_at)), 0);
  v_allow   := ceil(v_elapsed * v_s.max_tap_al_secondo)::int + v_s.max_tap_al_secondo;
  v_cap     := v_s.durata_s * v_s.max_tap_al_secondo;

  -- count cumulativo e monotòno: GREATEST evita cali su retry/out-of-order, LEAST applica i tetti
  insert into public.taps (session_id, guest_id, tap_count, updated_at)
  values (p_session, v_g.id, least(p_count, v_allow, v_cap), now())
  on conflict (session_id, guest_id) do update
    set tap_count  = least(greatest(taps.tap_count, excluded.tap_count), v_allow, v_cap),
        updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- 4.8 Chiusura sessione (solo regia): converte i tap in ticket. Idempotente.
create or replace function public.close_session(p_session uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_s public.tap_sessions;
  r   record;
  v_tickets int;
  v_total   int := 0;
begin
  if not public.is_staff('regia') then raise exception 'solo regia'; end if;

  select * into v_s from public.tap_sessions where id = p_session for update;
  if not found then raise exception 'sessione inesistente'; end if;
  if v_s.stato = 'closed' then return 0; end if;   -- idempotente

  for r in select * from public.taps where session_id = p_session loop
    v_tickets := floor(
      least(r.tap_count, v_s.durata_s * v_s.max_tap_al_secondo)::numeric / v_s.ticket_ogni
    )::int;
    if v_tickets > 0 and r.ticket_assegnati = 0 then
      update public.taps set ticket_assegnati = v_tickets
        where session_id = p_session and guest_id = r.guest_id;
      update public.guests set ticket_tap = ticket_tap + v_tickets
        where id = r.guest_id;
      insert into public.transactions
        (id, event_id, guest_id, tipo, qta_delta, ticket_delta, note)
      values
        (gen_random_uuid(), v_s.event_id, r.guest_id, 'tap', 0, v_tickets,
         'sessione ' || p_session::text);
      v_total := v_total + v_tickets;
    end if;
  end loop;

  update public.tap_sessions set stato = 'closed', closed_at = now() where id = p_session;
  return v_total;
end;
$$;

-- 4.9 Estrazione pesata (solo regia, solo fase ESTRAZIONE).
--     Senza reimmissione. Seed + snapshot salvati => riproducibile e verificabile.
create or replace function public.run_draw(
  p_event uuid, p_n_winners int, p_seed double precision default null
) returns public.draws
language plpgsql security definer set search_path = public
as $$
declare
  v_ev        public.events;
  v_seed      double precision;
  v_total     bigint;
  v_remaining bigint;
  v_pick      bigint;
  v_acc       bigint;
  v_n         int;
  r           record;
  v_winners   jsonb := '[]'::jsonb;
  v_snapshot  jsonb;
  v_draw      public.draws;
begin
  if not public.is_staff('regia') then raise exception 'solo regia'; end if;

  select * into v_ev from public.events where id = p_event;
  if not found then raise exception 'evento inesistente'; end if;
  if v_ev.fase <> 'ESTRAZIONE' then
    raise exception 'imposta la fase ESTRAZIONE prima del sorteggio';
  end if;
  if p_n_winners is null or p_n_winners < 1 then
    raise exception 'numero vincitori non valido';
  end if;

  v_seed := coalesce(p_seed, random());     -- seed registrato per la verifica
  perform setseed(v_seed);

  -- pool deterministico: ordine fisso per id (necessario per la riproducibilità)
  create temporary table _pool on commit drop as
    select id, nome, ticket_totali::bigint as tickets
      from public.guests
     where event_id = p_event and ticket_totali > 0
     order by id;

  select coalesce(
           jsonb_agg(jsonb_build_object('guest_id', id, 'nome', nome, 'tickets', tickets)
                     order by id), '[]'::jsonb),
         coalesce(sum(tickets), 0)
    into v_snapshot, v_total
    from _pool;

  if v_total = 0 then raise exception 'nessun ticket in gioco'; end if;

  v_n := least(p_n_winners, (select count(*) from _pool));
  v_remaining := v_total;

  for i in 1..v_n loop
    v_pick := floor(random() * v_remaining)::bigint;   -- 0 .. v_remaining-1
    v_acc  := 0;
    for r in select id, nome, tickets from _pool where tickets > 0 order by id loop
      v_acc := v_acc + r.tickets;
      if v_pick < v_acc then
        v_winners := v_winners || jsonb_build_object(
          'pos', i, 'guest_id', r.id, 'nome', r.nome, 'tickets', r.tickets);
        update _pool set tickets = 0 where id = r.id;   -- niente reimmissione
        v_remaining := v_remaining - r.tickets;
        exit;
      end if;
    end loop;
  end loop;

  insert into public.draws (event_id, seed, n_winners, pool_snapshot, winners)
  values (p_event, v_seed, v_n, v_snapshot, v_winners)
  returning * into v_draw;

  return v_draw;
end;
$$;

-- 4.10 Gestione parametri evento dalla dashboard (solo regia). Aggiorna solo i campi passati.
create or replace function public.update_event_settings(
  p_event uuid,
  p_prezzo_normale numeric default null,
  p_prezzo_premium numeric default null,
  p_tk_consumo_normale int default null,
  p_tk_consumo_premium int default null,
  p_tk_conv_normale int default null,
  p_tk_conv_premium int default null,
  p_tap_ticket_ogni int default null,
  p_durata_sessione_s int default null,
  p_max_tap_al_secondo int default null
) returns public.events
language plpgsql security definer set search_path = public
as $$
declare v_ev public.events;
begin
  if not public.is_staff('regia') then raise exception 'solo regia/admin'; end if;
  update public.events set
    prezzo_normale             = coalesce(p_prezzo_normale, prezzo_normale),
    prezzo_premium             = coalesce(p_prezzo_premium, prezzo_premium),
    ticket_consumo_normale     = coalesce(p_tk_consumo_normale, ticket_consumo_normale),
    ticket_consumo_premium     = coalesce(p_tk_consumo_premium, ticket_consumo_premium),
    ticket_conversione_normale = coalesce(p_tk_conv_normale, ticket_conversione_normale),
    ticket_conversione_premium = coalesce(p_tk_conv_premium, ticket_conversione_premium),
    tap_ticket_ogni            = coalesce(p_tap_ticket_ogni, tap_ticket_ogni),
    durata_sessione_s          = coalesce(p_durata_sessione_s, durata_sessione_s),
    max_tap_al_secondo         = coalesce(p_max_tap_al_secondo, max_tap_al_secondo)
  where id = p_event
  returning * into v_ev;
  if not found then raise exception 'evento inesistente'; end if;
  return v_ev;
end;
$$;

-- 4.11 Crea/aggiorna una voce di menù (solo regia). p_id NULL = nuova voce.
create or replace function public.upsert_drink(
  p_event uuid, p_id uuid, p_nome text, p_tipo text,
  p_descrizione text default null, p_categoria text default null,
  p_immagine_url text default null, p_ordine int default 0,
  p_visibile boolean default true, p_attivo boolean default true
) returns public.drinks
language plpgsql security definer set search_path = public
as $$
declare v_d public.drinks;
begin
  if not public.is_staff('regia') then raise exception 'solo regia/admin'; end if;
  if p_tipo not in ('normale','premium') then raise exception 'tipo non valido: %', p_tipo; end if;

  if p_id is null then
    insert into public.drinks
      (event_id, nome, tipo, descrizione, categoria, immagine_url, ordine, visibile, attivo)
    values
      (p_event, p_nome, p_tipo, p_descrizione, p_categoria, p_immagine_url,
       coalesce(p_ordine, 0), coalesce(p_visibile, true), coalesce(p_attivo, true))
    returning * into v_d;
  else
    update public.drinks set
      nome = p_nome, tipo = p_tipo, descrizione = p_descrizione, categoria = p_categoria,
      immagine_url = p_immagine_url, ordine = coalesce(p_ordine, 0),
      visibile = coalesce(p_visibile, true), attivo = coalesce(p_attivo, true)
    where id = p_id and event_id = p_event
    returning * into v_d;
    if not found then raise exception 'voce di menù inesistente'; end if;
  end if;
  return v_d;
end;
$$;

-- 4.12 Mostra/nascondi una voce dal menù dell'ospite (solo regia).
create or replace function public.set_drink_visibility(p_drink uuid, p_visibile boolean)
returns public.drinks
language plpgsql security definer set search_path = public
as $$
declare v_d public.drinks;
begin
  if not public.is_staff('regia') then raise exception 'solo regia/admin'; end if;
  update public.drinks set visibile = p_visibile where id = p_drink returning * into v_d;
  if not found then raise exception 'voce di menù inesistente'; end if;
  return v_d;
end;
$$;

-- 4.13 Abilita/disabilita l'ordinabilità alla cassa (solo regia).
create or replace function public.set_drink_active(p_drink uuid, p_attivo boolean)
returns public.drinks
language plpgsql security definer set search_path = public
as $$
declare v_d public.drinks;
begin
  if not public.is_staff('regia') then raise exception 'solo regia/admin'; end if;
  update public.drinks set attivo = p_attivo where id = p_drink returning * into v_d;
  if not found then raise exception 'voce di menù inesistente'; end if;
  return v_d;
end;
$$;

-- 4.14 Elimina una voce di menù (solo regia).
create or replace function public.delete_drink(p_drink uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_staff('regia') then raise exception 'solo regia/admin'; end if;
  delete from public.drinks where id = p_drink;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5) GRANTS (Supabase: ruoli anon / authenticated)
-- ----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant select on
  public.events, public.guests, public.drinks, public.transactions,
  public.tap_sessions, public.taps, public.draws
to authenticated;

grant execute on function
  public.app_role(),
  public.is_staff(text),
  public.totem_level(int),
  public.current_event(),
  public.register_guest(uuid, text),
  public.topup(uuid, text, int, numeric, uuid),
  public.consume(uuid, uuid, uuid),
  public.convert_credit(uuid, uuid),
  public.set_phase(uuid, text),
  public.start_session(uuid, int),
  public.register_taps(uuid, int),
  public.close_session(uuid),
  public.run_draw(uuid, int, double precision),
  public.update_event_settings(uuid, numeric, numeric, int, int, int, int, int, int, int),
  public.upsert_drink(uuid, uuid, text, text, text, text, text, int, boolean, boolean),
  public.set_drink_visibility(uuid, boolean),
  public.set_drink_active(uuid, boolean),
  public.delete_drink(uuid)
to authenticated;

-- ----------------------------------------------------------------------------
-- 6) SEED OPZIONALE (per test rapidi) — rimuovere in produzione.
-- ----------------------------------------------------------------------------
-- insert into public.events (nome) values ('Totem Night — test');
-- with e as (select id from public.events order by created_at desc limit 1)
-- insert into public.drinks (event_id, nome, tipo)
-- select e.id, x.nome, x.tipo from e,
--   (values ('Birra','normale'),('Calice','normale'),('Analcolico','normale'),
--           ('Cocktail','premium'),('Distillato','premium')) as x(nome,tipo);

-- ============================================================================
-- FINE — Step 1
-- ============================================================================
