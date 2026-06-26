// roles.ts — costanti ruoli staff, fonte di verità lato server.
//
// NB: NON è marcato 'server-only' di proposito — sono sole costanti/predicati puri
// (nessun secret), così possono essere importate anche dal modulo client lib/auth.ts
// senza trascinare argon2/jose/pg nel bundle del browser. lib/auth.ts oggi ridefinisce
// STAFF_ROLES/isStaffRole; al cutover (Fase 3) potrà re-esportare da qui per avere una
// sola definizione. La forma è identica a quella in lib/auth.ts e tests/db.mjs.

// Ruoli staff autorizzati alle postazioni protette. Combaciano col CHECK su
// auth.staff_users.role e con app_metadata.role letto da is_staff() nel DB.
export const STAFF_ROLES = ['cassa', 'regia', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// Type-guard riusabile.
export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return !!role && (STAFF_ROLES as readonly string[]).includes(role);
}
