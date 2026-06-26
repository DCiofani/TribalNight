import 'server-only';

// claims.ts — costruzione dei claims Postgres (request.jwt.claims).
//
// CONTRATTO CLAIMS (FISSO — identico a tests/db.mjs guestClaims/cassaClaims/regiaClaims,
// e a ciò che app_role()/auth.uid() leggono nel DB):
//   OSPITE : { sub }                                   -> app_role()='guest', is_staff()=false
//   STAFF  : { sub, app_metadata:{ role:'cassa'|'regia'|'admin' } }
//
// `sub` DEVE essere un UUID valido: auth.uid() (prelude.sql) fa il cast a uuid e
// altrimenti esplode. buildAnonClaims() genera sempre un randomUUID(), buildStaffClaims()
// riceve l'id dello staff (= auth.staff_users.id, già uuid).
//
// Questi oggetti sono ciò che viene:
//   1) firmato nel JWT (jwt.ts signAccess) per il trasporto browser<->backend;
//   2) iniettato in request.jwt.claims dentro withAuth() (lib/db.ts) per il DB.
// Tenere la forma identica = zero modifiche a schema/RPC/RLS/contract-test.

import { randomUUID } from 'node:crypto';
import { STAFF_ROLES, type StaffRole } from './roles';

// Claims ospite anonimo: solo { sub }. Nessun role -> app_role() ritorna 'guest'.
export interface GuestClaims {
  sub: string;
}

// Claims staff: { sub, app_metadata:{ role } }.
export interface StaffClaims {
  sub: string;
  app_metadata: { role: StaffRole };
}

export type Claims = GuestClaims | StaffClaims;

// buildAnonClaims() -> { sub } con sub = UUID fresco. Identità dell'ospite anonimo.
export function buildAnonClaims(): GuestClaims {
  return { sub: randomUUID() };
}

// buildStaffClaims(sub, role) -> { sub, app_metadata:{ role } }.
// sub = auth.staff_users.id (uuid). role validato contro STAFF_ROLES.
export function buildStaffClaims(sub: string, role: StaffRole): StaffClaims {
  if (!isValidUuid(sub)) {
    throw new Error(`buildStaffClaims: sub non è un UUID valido: ${sub}`);
  }
  if (!(STAFF_ROLES as readonly string[]).includes(role)) {
    throw new Error(`buildStaffClaims: ruolo non valido: ${role}`);
  }
  return { sub, app_metadata: { role } };
}

// Type-guard: i claims contengono un ruolo staff?
export function isStaffClaims(claims: Claims): claims is StaffClaims {
  return (
    typeof (claims as StaffClaims).app_metadata?.role === 'string' &&
    (STAFF_ROLES as readonly string[]).includes((claims as StaffClaims).app_metadata.role)
  );
}

// Validazione UUID (v1-v5 + variant). auth.uid() fa cast a uuid -> deve essere ben formato.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}
