// POST /api/auth/login — login staff email/password.
//
// Sostituisce supabase.auth.signInWithPassword() + il claim app_metadata.role
// (oggi staffSignIn in lib/auth.ts). Body: { email, password }.
//
// Pipeline:
//   1. valida input (email+password non vuoti);
//   2. lookupStaffForLogin(email) → riga auth.staff_users (id, password_hash, role) o null;
//   3. verifyPassword(hash, password) (argon2id);
//   4. su match: issueRefresh(staff.id, staff.role) emette access {sub,role} + refresh opaco
//      persistito (rotazione abilitata); setta i cookie; ritorna { role }.
//
// 401 GENERICO sia per email inesistente sia per password errata (no user-enumeration):
// stesso codice 'invalid_credentials'. Per non introdurre un timing-oracle quando l'email
// non esiste (salteremmo il costo argon2), verifichiamo comunque la password contro un hash
// fittizio — costo costante a prescindere dall'esistenza dell'utente.
//
// role ∈ {cassa,regia,admin} è server-authoritative: vive in staff_users.role, finisce nel
// claim firmato server-side e NON è modificabile dal client. La tabella staff_users contiene
// SOLO staff → login riuscito ⇒ ruolo staff valido (niente secondo check come col vecchio flow).
import 'server-only';
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { lookupStaffForLogin } from '@/lib/auth-server/staff';
import { hashPassword, verifyPassword } from '@/lib/auth-server/password';
import { issueRefresh } from '@/lib/auth-server/refresh';
import { setAccessCookie, setRefreshCookie } from '@/lib/auth-server/cookies';
import { errorJson, readJson, sameOriginOk } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hash argon2id fittizio per verifica a tempo (~)costante quando l'utente non esiste:
// evita un timing-oracle sull'esistenza dell'email (user-enumeration). DEVE essere
// generato dall'hasher REALE (stessi parametri argon2id di password.ts), NON un literal:
// un literal malformato farebbe lanciare/return-false a verifyPassword senza eseguire
// argon2, riaprendo il timing-oracle. Lo memoizziamo una sola volta (la prima richiesta
// con email inesistente paga l'hash; le successive riusano la promessa) su una password
// casuale mai usata, così verify() fallirà sempre ma al costo pieno di un argon2.verify.
let _dummyHashPromise: Promise<string> | null = null;
function dummyArgon2Hash(): Promise<string> {
  if (!_dummyHashPromise) {
    _dummyHashPromise = hashPassword(randomBytes(32).toString('hex'));
  }
  return _dummyHashPromise;
}

type LoginBody = { email?: unknown; password?: unknown };

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOriginOk(req)) return errorJson(403, 'forbidden');

  const body = await readJson<LoginBody>(req);
  if (!body) return errorJson(400, 'bad_request');

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return errorJson(400, 'bad_request');

  try {
    const staff = await lookupStaffForLogin(email);

    // Verifica password a tempo (~)costante: se l'utente non esiste, verifichiamo
    // comunque contro un hash fittizio reale (stesso costo argon2), poi 401 generico.
    const hashToCheck = staff?.passwordHash ?? (await dummyArgon2Hash());
    const ok = await verifyPassword(hashToCheck, password);

    if (!staff || !ok) return errorJson(401, 'invalid_credentials');

    const { access, refresh } = await issueRefresh(staff.id, staff.role);

    const res = NextResponse.json({ role: staff.role });
    setAccessCookie(res, access);
    setRefreshCookie(res, refresh);
    return res;
  } catch {
    // Errore interno (DB irraggiungibile, secret mancante): NON rivelare nulla.
    return errorJson(500, 'auth_error');
  }
}
