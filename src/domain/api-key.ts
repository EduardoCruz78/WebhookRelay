import { createHash, randomBytes } from 'node:crypto';

/**
 * source → may publish events, always under its own source name (it cannot spoof another).
 * admin  → manages subscriptions and deliveries.
 */
export type ApiKeyRole = 'source' | 'admin';

export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly role: ApiKeyRole;
  /** Required for `source` keys: the `source` stamped on every event they publish. */
  readonly source: string | null;
  /** SHA-256 of the key. The key itself is shown once at creation and never stored. */
  readonly keyHash: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

export const API_KEY_PREFIX = 'wr_';

/** 32 random bytes (256 bits) behind a recognizable prefix that secret scanners can match. */
export function generateApiKey(bytes: (size: number) => Buffer = randomBytes): string {
  return API_KEY_PREFIX + bytes(32).toString('base64url');
}

/**
 * A fast hash is enough here, unlike passwords: the key has 256 bits of entropy, so there is
 * nothing to brute-force, and hashing on every request must be cheap. bcrypt/argon2 exist to slow
 * down guessing of low-entropy human passwords.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

const SOURCE = /^[a-z][a-z0-9-]{1,62}$/;

export function isValidSource(source: string): boolean {
  return SOURCE.test(source);
}
