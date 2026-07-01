// Wrapper RPC tipizzati per la regia (l'organizzatore). UNICO punto da cui il client
// scrive sul dominio regia/organizer (fasi evento, estrazione, settings, listino drink).
// Niente ricalcolo: il front-end chiama la RPC e legge il risultato/Realtime.
// NB: NIENTE 'server-only' — questi wrapper girano nel browser con la anon key.
//
// Fase 3 (strangler, feature-flagged): ogni wrapper fa
//   if (USE_API) { fetch /api } else { supabase-js come oggi }.
// Stesso branching di lib/rpc.ts: il path supabase resta INVARIATO; le firme pubbliche
// NON cambiano e restano stabili per quando M2/M3 collegheranno app/regia/page.tsx.
// NON importiamo lib/db né lib/auth-server (server-only): l'API si parla via lib/api.
import type { SupabaseClient } from '@supabase/supabase-js';
import { USE_API } from '@/lib/backend-mode';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';
import { RpcError, type TipoConsumazione } from '@/lib/rpc';

// Fase del ciclo di vita dell'evento (autoritativa lato DB). La regia la fa avanzare
// con setPhase(); le pagine leggono lo stato corrente via Realtime, non lo calcolano.
export type Phase = 'SETUP' | 'APERTA' | 'LAST_CALL' | 'ESTRAZIONE' | 'CHIUSA';

// Una riga della classifica tap di una sessione: chi ha tappato e quanto. `tap_count` è il
// totale CUMULATIVO calcolato dal DB (register_taps: clamp/cap server-side) — il client non
// somma nulla, mostra solo la classifica ordinata.
export type LeaderboardRow = { guest_id: string; nome: string; tap_count: number };

// rethrow locale: lib/rpc.ts tiene il suo rethrow module-private, quindi ne ridefiniamo
// qui una copia identica (3 righe). Nasconde la differenza PostgREST/Supabase/route /api
// e porta un messaggio leggibile + il codice per i casi gestibili a UI.
function rethrow(error: {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}): never {
  throw new RpcError(error.message ?? 'Errore RPC', {
    code: error.code,
    details: error.details,
    hint: error.hint,
  });
}

// setPhase(...) -> fa avanzare la fase dell'evento (SETUP→APERTA→…→CHIUSA).
// La transizione è validata lato DB; qui non si applica nessuna logica di stato.
//
// Branch USE_API:
//   - API: POST /api/regia/phase { p_event, p_phase }.
//   - supabase (INVARIATO): rpc set_phase.
export async function setPhase(
  supabase: SupabaseClient,
  args: { eventId: string; phase: Phase },
): Promise<unknown> {
  if (USE_API) {
    return apiPost<unknown>('/api/regia/phase', {
      p_event: args.eventId,
      p_phase: args.phase,
    });
  }

  const { data, error } = await supabase.rpc('set_phase', {
    p_event: args.eventId,
    p_phase: args.phase,
  });
  if (error) rethrow(error);
  return data;
}

// runDraw(...) -> esegue l'estrazione dei vincitori per l'evento.
// seed opzionale: se passato rende l'estrazione riproducibile (default null → casuale).
// L'estrazione è autoritativa lato DB; il client non sorteggia nulla.
//
// Branch USE_API:
//   - API: POST /api/regia/draw { p_event, p_n_winners, p_seed }.
//   - supabase (INVARIATO): rpc run_draw.
export async function runDraw(
  supabase: SupabaseClient,
  args: { eventId: string; nWinners: number; seed?: number | null },
): Promise<unknown> {
  if (USE_API) {
    return apiPost<unknown>('/api/regia/draw', {
      p_event: args.eventId,
      p_n_winners: args.nWinners,
      p_seed: args.seed ?? null,
    });
  }

  const { data, error } = await supabase.rpc('run_draw', {
    p_event: args.eventId,
    p_n_winners: args.nWinners,
    p_seed: args.seed ?? null,
  });
  if (error) rethrow(error);
  return data;
}

// updateEventSettings(...) -> aggiorna i parametri economici/di gioco dell'evento.
// Tutti e 9 i campi sono OPZIONALI: quelli omessi (→ null) significano "non toccare",
// il DB fa coalesce sul valore esistente. Mappa camelCase → snake_case, ogni campo `?? null`.
//
// Branch USE_API:
//   - API: POST /api/regia/settings { payload }.
//   - supabase (INVARIATO): rpc update_event_settings.
export async function updateEventSettings(
  supabase: SupabaseClient,
  args: {
    eventId: string;
    prezzoNormale?: number | null;
    prezzoPremium?: number | null;
    tkConsumoNormale?: number | null;
    tkConsumoPremium?: number | null;
    tkConvNormale?: number | null;
    tkConvPremium?: number | null;
    tapTicketOgni?: number | null;
    durataSessioneS?: number | null;
    maxTapAlSecondo?: number | null;
  },
): Promise<unknown> {
  // payload condiviso dai due branch: omesso = null così il DB lascia il valore corrente.
  const payload = {
    p_event: args.eventId,
    p_prezzo_normale: args.prezzoNormale ?? null,
    p_prezzo_premium: args.prezzoPremium ?? null,
    p_tk_consumo_normale: args.tkConsumoNormale ?? null,
    p_tk_consumo_premium: args.tkConsumoPremium ?? null,
    p_tk_conv_normale: args.tkConvNormale ?? null,
    p_tk_conv_premium: args.tkConvPremium ?? null,
    p_tap_ticket_ogni: args.tapTicketOgni ?? null,
    p_durata_sessione_s: args.durataSessioneS ?? null,
    p_max_tap_al_secondo: args.maxTapAlSecondo ?? null,
  };

  if (USE_API) {
    return apiPost<unknown>('/api/regia/settings', payload);
  }

  const { data, error } = await supabase.rpc('update_event_settings', payload);
  if (error) rethrow(error);
  return data;
}

// startSession(...) -> apre una nuova sessione di gioco per l'evento.
// durata opzionale (secondi): se omessa (→ null) il DB usa la durata di default dell'evento.
//
// Branch USE_API:
//   - API: POST /api/regia/session/start { p_event, p_durata }.
//   - supabase (INVARIATO): rpc start_session.
export async function startSession(
  supabase: SupabaseClient,
  args: { eventId: string; durata?: number | null },
): Promise<unknown> {
  if (USE_API) {
    return apiPost<unknown>('/api/regia/session/start', {
      p_event: args.eventId,
      p_durata: args.durata ?? null,
    });
  }

  const { data, error } = await supabase.rpc('start_session', {
    p_event: args.eventId,
    p_durata: args.durata ?? null,
  });
  if (error) rethrow(error);
  return data;
}

// closeSession(...) -> chiude la sessione e ritorna il TOTALE ticket assegnati (number).
// DIVERGENZA DI SHAPE tra i due branch, normalizzata qui a `number`:
//   - la RPC supabase close_session ritorna un int "nudo" → lo restituiamo as number;
//   - la route /api lo incarta come { ticket: number } → estraiamo res.ticket.
// In entrambi i casi il chiamante riceve lo stesso number, firma stabile.
//
// Branch USE_API:
//   - API: POST /api/regia/session/close { p_session } → { ticket }.
//   - supabase (INVARIATO): rpc close_session → int.
export async function closeSession(
  supabase: SupabaseClient,
  args: { sessionId: string },
): Promise<number> {
  if (USE_API) {
    // `?? 0` difensivo: se la route rispondesse senza corpo (parseOk → null) torniamo 0,
    // coerente con la semantica idempotente della RPC (sessione già chiusa → 0 ticket).
    const res = await apiPost<{ ticket?: number }>('/api/regia/session/close', {
      p_session: args.sessionId,
    });
    return res?.ticket ?? 0;
  }

  const { data, error } = await supabase.rpc('close_session', {
    p_session: args.sessionId,
  });
  if (error) rethrow(error);
  return data as number;
}

// upsertDrink(...) -> crea (id null) o aggiorna (id valorizzato) una voce del listino drink.
// I default sono allineati alla route così i due branch si comportano IDENTICAMENTE:
// p_ordine=0, p_visibile=true, p_attivo=true; p_id/p_descrizione/p_categoria/p_immagine_url=null.
//
// Branch USE_API:
//   - API: POST /api/regia/drink { payload }.
//   - supabase (INVARIATO): rpc upsert_drink.
export async function upsertDrink(
  supabase: SupabaseClient,
  args: {
    eventId: string;
    id?: string | null;
    nome: string;
    tipo: TipoConsumazione;
    descrizione?: string | null;
    categoria?: string | null;
    immagineUrl?: string | null;
    ordine?: number | null;
    visibile?: boolean | null;
    attivo?: boolean | null;
  },
): Promise<unknown> {
  // payload condiviso dai due branch: default speculari a quelli della route /api.
  const payload = {
    p_event: args.eventId,
    p_id: args.id ?? null,
    p_nome: args.nome,
    p_tipo: args.tipo,
    p_descrizione: args.descrizione ?? null,
    p_categoria: args.categoria ?? null,
    p_immagine_url: args.immagineUrl ?? null,
    p_ordine: args.ordine ?? 0,
    p_visibile: args.visibile ?? true,
    p_attivo: args.attivo ?? true,
  };

  if (USE_API) {
    return apiPost<unknown>('/api/regia/drink', payload);
  }

  const { data, error } = await supabase.rpc('upsert_drink', payload);
  if (error) rethrow(error);
  return data;
}

// deleteDrink(...) -> elimina una voce del listino drink. Ritorna void in entrambi i branch.
// La route risponde { ok: true } ma non c'è nulla da leggere: lo ignoriamo.
// NB: apiDelete è usato nella forma a 2 argomenti apiDelete(path, body) — il body porta
// il p_drink (lib/api.ts viene esteso in parallelo per accettarlo).
//
// Branch USE_API:
//   - API: DELETE /api/regia/drink { p_drink } → { ok:true } (ignorato).
//   - supabase (INVARIATO): rpc delete_drink.
export async function deleteDrink(
  supabase: SupabaseClient,
  args: { drinkId: string },
): Promise<void> {
  if (USE_API) {
    await apiDelete('/api/regia/drink', { p_drink: args.drinkId });
    return;
  }

  const { error } = await supabase.rpc('delete_drink', {
    p_drink: args.drinkId,
  });
  if (error) rethrow(error);
}

// setDrinkVisibility(...) -> mostra/nasconde una voce del listino agli ospiti.
// "visibile" è distinto da "attivo": una voce può essere attiva ma temporaneamente nascosta.
//
// Branch USE_API:
//   - API: PATCH /api/regia/drink/visibility { p_drink, p_visibile }.
//   - supabase (INVARIATO): rpc set_drink_visibility.
export async function setDrinkVisibility(
  supabase: SupabaseClient,
  args: { drinkId: string; visibile: boolean },
): Promise<unknown> {
  if (USE_API) {
    return apiPatch<unknown>('/api/regia/drink/visibility', {
      p_drink: args.drinkId,
      p_visibile: args.visibile,
    });
  }

  const { data, error } = await supabase.rpc('set_drink_visibility', {
    p_drink: args.drinkId,
    p_visibile: args.visibile,
  });
  if (error) rethrow(error);
  return data;
}

// setDrinkActive(...) -> attiva/disattiva una voce del listino (rimozione "morbida").
// Una voce non attiva esce dal listino ordinabile pur restando in archivio.
//
// Branch USE_API:
//   - API: PATCH /api/regia/drink/active { p_drink, p_attivo }.
//   - supabase (INVARIATO): rpc set_drink_active.
export async function setDrinkActive(
  supabase: SupabaseClient,
  args: { drinkId: string; attivo: boolean },
): Promise<unknown> {
  if (USE_API) {
    return apiPatch<unknown>('/api/regia/drink/active', {
      p_drink: args.drinkId,
      p_attivo: args.attivo,
    });
  }

  const { data, error } = await supabase.rpc('set_drink_active', {
    p_drink: args.drinkId,
    p_attivo: args.attivo,
  });
  if (error) rethrow(error);
  return data;
}

// getLeaderboard(...) -> classifica tap di una sessione: [{ guest_id, nome, tap_count }]
// ordinata per tap_count desc. Sola lettura, NIENTE ricalcolo: tap_count è il totale
// cumulativo prodotto dal DB (register_taps con clamp/cap), il client si limita a mostrarlo.
// Alimenta la leaderboard live di R3. Gate staff (regia/admin) lato route (RLS) o RLS diretta.
//
// register_taps fa upsert su (session_id, guest_id) → 1 riga per (sessione, ospite): niente
// da aggregare, si legge taps join guests e si ordina. Lo staff legge tutte le righe grazie
// alle policy taps_select/guests_select (is_staff()).
//
// Branch USE_API:
//   - API: GET /api/regia/session/leaderboard?session=<id> → LeaderboardRow[]
//     (gate ruolo regia/admin server-side; join+order+limit nella route).
//   - supabase (INVARIATO come stile listDrinks): select su taps con embed guests(nome),
//     filtrata session_id, order tap_count desc; poi appiattita a LeaderboardRow.
export async function getLeaderboard(
  supabase: SupabaseClient,
  args: { sessionId: string },
): Promise<LeaderboardRow[]> {
  if (USE_API) {
    return apiGet<LeaderboardRow[]>(
      `/api/regia/session/leaderboard?session=${encodeURIComponent(args.sessionId)}`,
    );
  }

  // Embed su FK taps.guest_id → guests.id: guests(nome) arriva come oggetto annidato.
  // !inner scarta eventuali orfani (guest cancellato) e permette l'order sul nome.
  const { data, error } = await supabase
    .from('taps')
    .select('guest_id, tap_count, guests!inner(nome)')
    .eq('session_id', args.sessionId)
    .order('tap_count', { ascending: false })
    .limit(50);
  if (error) rethrow(error);

  // Appiattisco l'embed {guests:{nome}} → {nome}. Supabase può tipizzare l'embed come
  // oggetto o array a seconda dell'inferenza FK: normalizzo entrambe le forme.
  type Nested = {
    guest_id: string;
    tap_count: number;
    guests: { nome: string } | { nome: string }[] | null;
  };
  return ((data as Nested[] | null) ?? []).map((r) => {
    const g = Array.isArray(r.guests) ? r.guests[0] : r.guests;
    return { guest_id: r.guest_id, nome: g?.nome ?? '', tap_count: r.tap_count };
  });
}
