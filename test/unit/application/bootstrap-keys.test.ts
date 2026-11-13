import { beforeEach, describe, expect, it } from 'vitest';

import { ensureBootstrapKeys } from '../../../src/application/bootstrap-keys.js';
import { hashApiKey } from '../../../src/domain/api-key.js';
import { minutesAfter, NOW } from '../../support/builders.js';
import { FakeStore, sequentialIds } from '../../support/fakes.js';

let store: FakeStore;
const deps = () => ({ unitOfWork: store.unitOfWork, now: NOW, newId: sequentialIds() });

// Values shaped like Render's generateValue output (base64 of 256 random bits).
const ADMIN = 'q3T0Yg+8h2v/Jk1Lm9Nn0pQrStUvWxYz0123456789A=';
const SOURCE = 'Zm9vYmFyYmF6cXV4K2RlbW8vc2NoZWR1bGluZy1hcGk=';

beforeEach(() => {
  store = new FakeStore();
});

describe('ensureBootstrapKeys', () => {
  it('stores each configured key as a hash with its role and source', async () => {
    await ensureBootstrapKeys(
      [
        { role: 'admin', source: null, key: ADMIN },
        { role: 'source', source: 'scheduling-api', key: SOURCE },
      ],
      deps(),
    );

    expect(await store.repositories.apiKeys.findActiveByHash(hashApiKey(ADMIN))).toMatchObject({
      name: 'bootstrap:admin',
      role: 'admin',
      source: null,
    });
    expect(await store.repositories.apiKeys.findActiveByHash(hashApiKey(SOURCE))).toMatchObject({
      name: 'bootstrap:source:scheduling-api',
      role: 'source',
      source: 'scheduling-api',
    });
    expect(JSON.stringify([...store.state.apiKeys.values()])).not.toContain(ADMIN);
  });

  it('does nothing on a restart with the same values', async () => {
    const keys = [{ role: 'admin' as const, source: null, key: ADMIN }];
    await ensureBootstrapKeys(keys, deps());

    await ensureBootstrapKeys(keys, deps());

    expect(store.state.apiKeys.size).toBe(1);
  });

  it('rotates: a new value revokes the previous bootstrap key of the same name', async () => {
    await ensureBootstrapKeys([{ role: 'admin', source: null, key: ADMIN }], deps());
    const rotated = 'bmV3LWFkbWluLWtleS1hZnRlci1yb3RhdGlvbi0xMjM0NTY=';

    await ensureBootstrapKeys([{ role: 'admin', source: null, key: rotated }], {
      ...deps(),
      now: minutesAfter(NOW, 60),
    });

    expect(await store.repositories.apiKeys.findActiveByHash(hashApiKey(ADMIN))).toBeUndefined();
    expect(await store.repositories.apiKeys.findActiveByHash(hashApiKey(rotated))).toBeDefined();
  });
});
