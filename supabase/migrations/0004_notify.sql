-- ============================================================================
-- TOTEM NIGHT — 0004_notify.sql  (Fase 4 — realtime via LISTEN/NOTIFY)
--
-- Sostituisce il POLLING 2s del path API (USE_API) con realtime vero: il DB
-- emette pg_notify() ad ogni cambio di stato rilevante; il listener server
-- (lib/sse/listener.ts) ascolta su una connessione PG DIRETTA e fa il fan-out
-- ai client via SSE. Il path supabase (postgres_changes) NON usa questi trigger.
--
-- PRIVACY — il payload NOTIFY porta SOLO identificatori, MAI dati sensibili:
--   * canale `guest_state` : { "guest_id": "<uuid>" }            (no pin/saldi)
--   * canale `event_phase` : { "event_id": "<uuid>", "fase": "<fase>" }
-- Il client, ricevuto l'id, RILEGGE la riga autoritativa via GET /api/guest/[id]
-- (RLS-scoped). Stesso principio di useGuestState che rilegge perché
-- ticket_totali è GENERATED: il NOTIFY è SOLO un trigger, non un canale dati.
--
-- ANTI-BURST — NESSUN trigger su `taps`: i tap arrivano a raffica (decine/s) e
-- non devono generare un NOTIFY per riga. Lo stato ospite cambia su `guests`
-- (topup/consume/convert/close_session aggiornano la riga guests) → è lì che
-- mettiamo il trigger, una sola notifica per UPDATE della riga.
--
-- IDEMPOTENTE — drop trigger if exists + create or replace function: la
-- migrazione si può ri-applicare senza errori.
--
-- SECURITY DEFINER — le funzioni trigger girano come owner (postgres). pg_notify
-- non richiede privilegi particolari, ma definiamo le funzioni come owner e con
-- search_path fisso per coerenza con le altre funzioni dello schema (0001_init)
-- e per non dipendere dal search_path del chiamante.
--
-- Va applicato dopo 0001_init.sql (richiede public.guests e public.events).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- guests: notifica il cambio di stato di un singolo ospite.
-- Si attiva su QUALSIASI UPDATE della riga (topup/consume/convert/close_session
-- aggiornano saldi/ticket/livello). Il payload porta SOLO l'id: il listener fa
-- il fan-out ai subscriber di quel guest, che rileggono la riga via API (RLS).
-- ----------------------------------------------------------------------------
create or replace function public.notify_guest_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- payload minimo: solo l'id dell'ospite. MAI pin/saldi/ticket.
  perform pg_notify('guest_state', json_build_object('guest_id', new.id)::text);
  return new;
end;
$$;

drop trigger if exists trg_notify_guest_state on public.guests;
create trigger trg_notify_guest_state
  after update on public.guests
  for each row
  execute function public.notify_guest_state();

-- ----------------------------------------------------------------------------
-- events: notifica il cambio di FASE (set_phase). Trigger ristretto alla colonna
-- `fase` (AFTER UPDATE OF fase) così altri update dell'evento (prezzi, settings)
-- non emettono notifiche di fase. Il payload porta event_id + la nuova fase:
-- la fase è uno stato pubblico/di regia (non un dato personale), quindi può
-- viaggiare nel payload e risparmiare al client un refetch dell'evento.
-- ----------------------------------------------------------------------------
create or replace function public.notify_event_phase()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_notify(
    'event_phase',
    json_build_object('event_id', new.id, 'fase', new.fase)::text
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_event_phase on public.events;
create trigger trg_notify_event_phase
  after update of fase on public.events
  for each row
  -- emette solo se la fase è EFFETTIVAMENTE cambiata (no-op update non notificano).
  when (old.fase is distinct from new.fase)
  execute function public.notify_event_phase();

-- Le funzioni sono di proprietà del ruolo che applica la migrazione (owner/postgres):
-- nessun GRANT execute esplicito serve, sono invocate dai trigger as-definer.
