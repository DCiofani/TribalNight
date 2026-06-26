import 'server-only';

// staff.ts — lookup di auth.staff_users per il login (verifica password lato server).
//
// Le tabelle auth.* NON sono leggibili dal ruolo `authenticated` (sono dati di sistema,
// mai esposti via RLS al client): quindi qui NON si usa lib/db.ts::withAuth. Si usa il
// pool DEDICATO DI SERVIZIO unico (lib/auth-server/service-db.ts: ruolo owner/service,
// query dirette senza SET ROLE), condiviso con refresh.ts. Non eredita mai claims utente.
//
// Sicurezza login: lookupStaffForLogin ritorna SEMPRE una shape uniforme (o null se email
// inesistente). Il chiamante (/api/auth/login) NON deve distinguere "email inesistente" da
// "password errata": stesso 401 generico, niente user-enumeration. Per non saltare il costo
// argon2 quando l'email non esiste (timing oracle), il chiamante verifica comunque contro un
// hash fittizio reale (vedi login/route.ts).

import { STAFF_ROLES, type StaffRole } from './roles';
import { serviceDb } from './service-db';

export interface StaffRecord {
  id: string; // uuid → diventa sub nei claims
  passwordHash: string; // argon2id, da verificare con verifyPassword
  role: StaffRole;
}

// lookupStaffForLogin(email) -> StaffRecord | null.
// null se: email inesistente, utente disabilitato (disabled_at non null), o ruolo non
// valido (difesa: una riga con ruolo fuori CHECK non deve mai diventare uno staff valido).
// L'email è confrontata lower-case/trim (gli indirizzi sono case-insensitive di fatto;
// l'insert dovrebbe normalizzare, qui difendiamo comunque con lower()).
export async function lookupStaffForLogin(
  email: string,
): Promise<StaffRecord | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const res = await serviceDb().query(
    `select id, password_hash, role
       from auth.staff_users
      where lower(email) = $1
        and disabled_at is null
      limit 1`,
    [normalized],
  );
  if (res.rowCount === 0) return null;

  const row = res.rows[0] as {
    id: string;
    password_hash: string;
    role: string;
  };
  if (!(STAFF_ROLES as readonly string[]).includes(row.role)) return null;

  return {
    id: row.id,
    passwordHash: row.password_hash,
    role: row.role as StaffRole,
  };
}
