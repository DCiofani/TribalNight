import 'server-only';

// refresh.ts — REFRESH token opachi (non-JWT), hashati in DB, con rotazione e revoca.
//
// Perché opachi e non JWT: un refresh opaco è revocabile ISTANTANEAMENTE (basta marcare
// la riga revoked_at). Un JWT di refresh resterebbe valido fino a scadenza anche dopo
// logout/compromissione. Vive in cookie HttpOnly (tn_rt), TTL lungo (durata serata).
//
// Forma del valore opaco: `${uuidv4}.${48 byte random base64url}` — entropia abbondante,
// non indovinabile. In DB salviamo SOLO sha256(token) (token_hash, PK): se il dump del DB
// trapela, i refresh in chiaro non sono ricostruibili. Il valore in chiaro esiste solo
// nel cookie del client e per la durata della richiesta.
//
// ── SCELTA DEL RUOLO DB (importante) ───────────────────────────────────────────────
// Le tabelle auth.* (staff_users, refresh_tokens) NON sono leggibili dal ruolo
// `authenticated` (nessun grant: sono dati di sistema, mai esposti via RLS al client).
// Quindi qui NON si usa lib/db.ts::withAuth (che fa `set local role authenticated`).
// Si usa il POOL DEDICATO DI SERVIZIO unico (lib/auth-server/service-db.ts) che si connette
// con un ruolo owner/service ed esegue query DIRETTE (nessun SET ROLE), esattamente come
// tests/db.mjs fa il `setup()` da owner con `reset role`. È SEPARATO da quello applicativo
// (lib/db.ts): non eredita mai claims utente.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { STAFF_ROLES, type StaffRole } from './roles';
import { signAccess } from './jwt';
import { buildStaffClaims, type Claims } from './claims';
import { serviceDb } from './service-db';

// TTL del refresh: 16h ~ copre una serata abbondante. Alla fine evento si revoca per sub.
const REFRESH_TTL_SECONDS = 16 * 60 * 60;

// ── Helpers token opaco ─────────────────────────────────────────────────────────────
function mintOpaqueToken(): string {
  // uuid (univocità) + 48 byte random (entropia) → stringa opaca non indovinabile.
  return `${randomUUID()}.${randomBytes(48).toString('base64url')}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// Confronto in tempo costante degli hash (entrambi hex di lunghezza fissa).
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface IssuedSession {
  access: string; // JWT HS256 (cookie tn_at)
  refresh: string; // token opaco in chiaro (cookie tn_rt) — NON persistito in chiaro
}

// ── issueRefresh(sub, role) ─────────────────────────────────────────────────────────
// Emette una nuova coppia { access, refresh } e PERSISTE l'hash del refresh in
// auth.refresh_tokens. role = null/undefined per l'ospite anonimo, altrimenti uno
// STAFF_ROLES. Restituisce i valori in chiaro da mettere nei cookie.
export async function issueRefresh(
  sub: string,
  role?: StaffRole | null
): Promise<IssuedSession> {
  const normalizedRole =
    role && (STAFF_ROLES as readonly string[]).includes(role) ? role : null;

  const refresh = mintOpaqueToken();
  const tokenHash = sha256Hex(refresh);

  await serviceDb().query(
    `insert into auth.refresh_tokens (token_hash, sub, role, issued_at, expires_at)
       values ($1, $2, $3, now(), now() + make_interval(secs => $4))`,
    [tokenHash, sub, normalizedRole, REFRESH_TTL_SECONDS]
  );

  const access = await signAccess(claimsFor(sub, normalizedRole));
  return { access, refresh };
}

// ── rotateRefresh(token) ────────────────────────────────────────────────────────────
// Verifica il refresh ricevuto (non scaduto, non revocato), poi RUOTA:
//   - emette un nuovo refresh + nuovo access;
//   - marca il vecchio come revoked_at=now() e replaced_by=<hash nuovo> (catena d'audit
//     + mitigazione replay: un refresh usato due volte trova la riga già revocata).
// Tutto in una singola transazione (atomicità: o ruota o nulla).
// Ritorna { access, refresh } | null. null = token sconosciuto/scaduto/revocato -> 401.
export async function rotateRefresh(
  token: string | undefined | null
): Promise<IssuedSession | null> {
  if (!token) return null;
  const incomingHash = sha256Hex(token);

  const client = await serviceDb().connect();
  try {
    await client.query('begin');

    // FOR UPDATE: serializza un eventuale uso concorrente dello stesso refresh.
    const found = await client.query(
      `select token_hash, sub, role, expires_at, revoked_at
         from auth.refresh_tokens
        where token_hash = $1
        for update`,
      [incomingHash]
    );

    if (found.rowCount === 0) {
      await client.query('rollback');
      return null;
    }

    const row = found.rows[0] as {
      token_hash: string;
      sub: string;
      role: string | null;
      expires_at: Date;
      revoked_at: Date | null;
    };

    // Difesa contro tampering dell'hash (timing-safe) + check stato.
    if (!hashesEqual(row.token_hash, incomingHash)) {
      await client.query('rollback');
      return null;
    }
    // REUSE DETECTION (replay / furto): la riga esiste MA è già revocata. Significa che
    // questo refresh è già stato consumato (ruotato al primo uso → revoked_at valorizzato)
    // e ora viene ripresentato. È il sintomo classico di un token rubato usato in parallelo
    // al legittimo. Reazione difensiva: KILL-ALL delle sessioni di questo sub, così sia il
    // ladro sia (purtroppo) la vittima vengono sloggati e costretti a ri-autenticarsi —
    // preferibile a lasciare viva una catena compromessa. Si chiude prima la tx (rilascia
    // il FOR UPDATE su questa riga), poi si revoca tutto per sub sulla connessione di servizio.
    if (row.revoked_at !== null) {
      await client.query('rollback');
      await revokeAllForSub(row.sub);
      return null;
    }
    if (row.expires_at.getTime() <= Date.now()) {
      await client.query('rollback');
      return null;
    }

    const normalizedRole =
      row.role && (STAFF_ROLES as readonly string[]).includes(row.role)
        ? (row.role as StaffRole)
        : null;

    // Nuovo refresh + persistenza hash, ereditando sub/role della catena.
    const newRefresh = mintOpaqueToken();
    const newHash = sha256Hex(newRefresh);

    const inserted = await client.query(
      `insert into auth.refresh_tokens (token_hash, sub, role, issued_at, expires_at)
         values ($1, $2, $3, now(), now() + make_interval(secs => $4))
       returning id`,
      [newHash, row.sub, normalizedRole, REFRESH_TTL_SECONDS]
    );
    const newId = (inserted.rows[0] as { id: string }).id;

    // Revoca + collega il vecchio al nuovo (replaced_by è uuid FK a id → usa l'id, non l'hash).
    await client.query(
      `update auth.refresh_tokens
          set revoked_at = now(), replaced_by = $2
        where token_hash = $1`,
      [incomingHash, newId]
    );

    await client.query('commit');

    const access = await signAccess(claimsFor(row.sub, normalizedRole));
    return { access, refresh: newRefresh };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── revoke(token) ───────────────────────────────────────────────────────────────────
// Revoca un singolo refresh (logout). Idempotente: marcare due volte non cambia nulla.
// Non rivela se il token esistesse (no leak): ritorna sempre void.
export async function revoke(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const tokenHash = sha256Hex(token);
  await serviceDb().query(
    `update auth.refresh_tokens
        set revoked_at = now()
      where token_hash = $1 and revoked_at is null`,
    [tokenHash]
  );
}

// ── revokeAllForSub(sub) ────────────────────────────────────────────────────────────
// "Kill all sessions" per un soggetto (es. revoca staff, o pulizia a fine evento).
// Ritorna il numero di refresh revocati.
export async function revokeAllForSub(sub: string): Promise<number> {
  const res = await serviceDb().query(
    `update auth.refresh_tokens
        set revoked_at = now()
      where sub = $1 and revoked_at is null`,
    [sub]
  );
  return res.rowCount ?? 0;
}

// claimsFor: costruisce i Claims (forma fissa) da sub + role-o-null.
function claimsFor(sub: string, role: StaffRole | null): Claims {
  return role ? buildStaffClaims(sub, role) : { sub };
}

export { REFRESH_TTL_SECONDS };
