import type { FastifyInstance } from 'fastify';

import { newId } from '../../src/application/ids.js';
import { createRuntime, type Runtime } from '../../src/composition.js';
import { generateApiKey, hashApiKey, type ApiKeyRole } from '../../src/domain/api-key.js';
import { buildApp } from '../../src/http/app.js';
import { DELIVERY_QUEUE } from '../../src/infrastructure/queue/delivery-queue.js';
import { NOW } from './builders.js';
import { FakeClock } from './fakes.js';
import { createTestDatabase, type TestDatabase } from './database.js';

export interface TestApp {
  readonly app: FastifyInstance;
  readonly runtime: Runtime;
  readonly testDb: TestDatabase;
  readonly clock: FakeClock;
  /** Creates an API key and returns the `Authorization` header value for it. */
  bearer(role: ApiKeyRole, source?: string): Promise<string>;
  /** Jobs waiting in the pg-boss delivery queue. */
  queuedJobs(): Promise<{ deliveryId: string; startAfter: Date }[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** The real application (Fastify + PostgreSQL + pg-boss) on a fresh database, with a fake clock. */
export async function createTestApp(): Promise<TestApp> {
  const testDb = await createTestDatabase();
  const clock = new FakeClock(NOW);
  const runtime = await createRuntime(
    { DATABASE_URL: testDb.url, DATABASE_POOL_SIZE: 5, MIGRATE_ON_START: false },
    (error) => {
      throw error;
    },
    clock,
  );
  const app = await buildApp({ LOG_LEVEL: 'silent' }, runtime.app);

  return {
    app,
    runtime,
    testDb,
    clock,
    async bearer(role, source) {
      const key = generateApiKey();
      await runtime.database.repositories.apiKeys.insert({
        id: newId(),
        name: `${role} key`,
        role,
        source: source ?? null,
        keyHash: hashApiKey(key),
        createdAt: NOW,
        revokedAt: null,
      });
      return `Bearer ${key}`;
    },
    async queuedJobs() {
      const { rows } = await runtime.database.pool.query<{
        delivery_id: string;
        start_after: Date;
      }>(`SELECT data->>'deliveryId' AS delivery_id, start_after FROM pgboss.job WHERE name = $1`, [
        DELIVERY_QUEUE,
      ]);
      return rows.map((row) => ({ deliveryId: row.delivery_id, startAfter: row.start_after }));
    },
    async reset() {
      await testDb.reset();
      await runtime.database.pool.query('DELETE FROM pgboss.job WHERE name = $1', [DELIVERY_QUEUE]);
    },
    async close() {
      await app.close();
      await runtime.close();
    },
  };
}
