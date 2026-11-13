import type { ApiKey } from '../domain/api-key.js';
import { hashApiKey } from '../domain/api-key.js';
import type { UnitOfWork } from './ports.js';

export interface BootstrapKey {
  readonly role: ApiKey['role'];
  readonly source: string | null;
  readonly key: string;
}

/** Name that marks a key as managed from the environment (and so replaceable by it). */
export const bootstrapName = (key: Pick<BootstrapKey, 'role' | 'source'>): string =>
  key.role === 'admin' ? 'bootstrap:admin' : `bootstrap:source:${key.source ?? ''}`;

/**
 * Hosts without a shell (Render's free tier) cannot run the CLI, so the first keys come from
 * environment variables, which the platform can generate. At startup each one is stored as a
 * hash if it is not there yet; a previous bootstrap key with the same name is revoked, so changing
 * the variable rotates the key.
 */
export async function ensureBootstrapKeys(
  keys: readonly BootstrapKey[],
  deps: { unitOfWork: UnitOfWork; now: Date; newId: () => string },
): Promise<void> {
  for (const key of keys) {
    const name = bootstrapName(key);
    const keyHash = hashApiKey(key.key);
    await deps.unitOfWork.run(async ({ repositories }) => {
      if (await repositories.apiKeys.findActiveByHash(keyHash)) return;
      await repositories.apiKeys.revokeByName(name, deps.now);
      await repositories.apiKeys.insert({
        id: deps.newId(),
        name,
        role: key.role,
        source: key.source,
        keyHash,
        createdAt: deps.now,
        revokedAt: null,
      });
    });
  }
}
