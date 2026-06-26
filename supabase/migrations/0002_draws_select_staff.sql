-- Hardening RLS (review infra multi-agente 2026-06-26 — finding sicurezza/GDPR).
-- v0.1 dello schema aveva: draws_select ... using (true) → QUALSIASI autenticato
-- (incluso un ospite anonimo) poteva leggere draws.pool_snapshot = nomi + ticket
-- dell'INTERA platea dopo l'estrazione. Leak di dati personali (GDPR).
--
-- Fix: la lettura diretta di draws è riservata allo staff. Il reveal dei VINCITORI
-- agli ospiti (M4) avverrà via canale curato dalla regia / payload anonimizzato
-- (pos + tickets, senza l'elenco completo dei nomi), non via SELECT diretta su draws.
alter policy draws_select on public.draws using (public.is_staff());
