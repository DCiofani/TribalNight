-- ============================================================================
-- TOTEM NIGHT — 0006_notify_drinks.sql  (Fase 4 — realtime menù/listino drinks)
--
-- Stessa filosofia di 0004_notify.sql: il DB emette pg_notify() ad ogni cambio
-- del listino drinks di un evento; il listener server (lib/sse/listener.ts)
-- ascolta su connessione PG DIRETTA e fa il fan-out ai client via SSE
-- (canale 'drinks_changed'). Il path supabase (postgres_changes) NON usa questo
-- trigger.
--
-- PRIVACY/PAYLOAD MINIMO — il payload NOTIFY porta SOLO l'identificatore evento:
--   * canale `drinks_changed` : { "event_id": "<uuid>" }
-- Nessun campo del drink (nome/prezzo/visibilità) viaggia nel NOTIFY: il client,
-- ricevuto l'event_id, RILEGGE il listino autoritativo via GET /api/regia/drink
-- (scope visible/active/all, RLS-scoped). Il NOTIFY è SOLO un trigger di refetch.
--
-- COPERTURA — a differenza di guests (solo UPDATE), qui serve AFTER INSERT OR
-- UPDATE OR DELETE: il listino cambia anche quando un drink viene aggiunto o
-- rimosso (oltre a toggle visibile/attivo, prezzo, ordine, ecc). I drinks NON
-- arrivano a raffica come i taps, quindi un NOTIFY per riga è accettabile.
--
-- coalesce(new.event_id, old.event_id): su INSERT/UPDATE è disponibile NEW, su
-- DELETE solo OLD. event_id è NOT NULL e immutabile (FK), quindi il coalesce
-- restituisce sempre l'evento corretto.
--
-- IDEMPOTENTE — drop trigger if exists + create or replace function: la
-- migrazione si può ri-applicare senza errori.
--
-- SECURITY DEFINER + search_path fisso: coerente con 0001_init / 0004_notify.
--
-- Va applicato dopo 0001_init.sql (richiede public.drinks).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- drinks: notifica il cambio del listino di un evento. Si attiva su INSERT,
-- UPDATE e DELETE di una riga drink. Il payload porta SOLO l'event_id: il
-- listener fa il fan-out ai subscriber di quell'evento, che rileggono il
-- listino via API (RLS).
-- ----------------------------------------------------------------------------
create or replace function public.notify_drinks_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- payload minimo: solo l'event_id. coalesce per coprire anche il DELETE (no NEW).
  perform pg_notify(
    'drinks_changed',
    json_build_object('event_id', coalesce(new.event_id, old.event_id))::text
  );
  -- AFTER trigger: il valore di ritorno è ignorato, ma per le righe restituiamo
  -- new su INSERT/UPDATE e old su DELETE (new è null sui DELETE).
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_notify_drinks_changed on public.drinks;
create trigger trg_notify_drinks_changed
  after insert or update or delete on public.drinks
  for each row
  execute function public.notify_drinks_changed();

-- Le funzioni sono di proprietà del ruolo che applica la migrazione (owner/postgres):
-- nessun GRANT execute esplicito serve, sono invocate dal trigger as-definer.
