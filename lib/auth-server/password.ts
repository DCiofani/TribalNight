import 'server-only';

// password.ts — hashing/verifica password staff con argon2id.
//
// Usato SOLO server-side (route /api/auth/login, seed/CLI creazione staff).
// L'hash finisce in app_auth.staff_users.password_hash; la password in chiaro non
// lascia mai il backend. argon2id = variante raccomandata OWASP (resistente sia a
// side-channel sia a GPU/TPU cracking).
//
// Dipendenza: `argon2` (binding nativo). Va in `dependencies` del package.json.

import argon2 from 'argon2';

// Parametri argon2id. Allineati alle raccomandazioni OWASP 2024 (m=19MiB, t=2, p=1).
// La stringa hash prodotta è self-describing (include algoritmo + parametri + salt),
// quindi verify() resta valida anche se in futuro si alzano questi costi.
const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

// hashPassword(plain) -> stringa hash PHC ($argon2id$...). Da persistere as-is.
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: password vuota');
  }
  return argon2.hash(plain, ARGON2_OPTS);
}

// verifyPassword(hash, plain) -> true se la password corrisponde all'hash.
// Non lancia su mismatch: ritorna false. Lancia solo su hash malformato/illeggibile,
// che è un errore di programmazione/dati corrotti (lo lasciamo propagare).
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (!hash || typeof plain !== 'string') return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // argon2.verify lancia se l'hash non è un PHC valido. Trattiamo come "non valido".
    return false;
  }
}
