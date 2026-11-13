import type { FastifyInstance } from 'fastify';

import { newId } from '../../src/application/ids.js';
import { createRuntime, type Runtime } from '../../src/composition.js';
import { generateApiKey, hashApiKey, type ApiKeyRole } from '../../src/domain/api-key.js';
import { buildApp } from '../../src/http/app.js';
import { DELIVERY_QUEUE } from '../../src/infrastructure/queue/delivery-queue.js';
import { NOW } from './builders.js';
import type { Clock, RandomSource } from '../../src/domain/clock.js';
import { FakeClock } from './fakes.js';
import { createTestDatabase, type TestDatabase } from './database.js';

export interface TestApp {
  readonly app: FastifyInstance;
  readonly runtime: Runtime;
  readonly testDb: TestDatabase;
  readonly clock: Clock;
  /** Creates an API key and returns the `Authorization` header value for it. */
  bearer(role: ApiKeyRole, source?: string): Promise<string>;
  /** Jobs waiting in the pg-boss delivery queue. */
  queuedJobs(): Promise<{ deliveryId: string; startAfter: Date }[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Defaults to a FakeClock frozen at NOW. Pass systemClock when a real worker must pick jobs up. */
  readonly clock?: Clock;
  readonly deliveryTimeoutMs?: number;
  readonly random?: RandomSource;
}

/** The real application (Fastify + PostgreSQL + pg-boss) on a fresh database. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const testDb = await createTestDatabase();
  const clock = options.clock ?? new FakeClock(NOW);
  const runtime = await createRuntime(
    {
      DATABASE_URL: testDb.url,
      DATABASE_POOL_SIZE: 5,
      MIGRATE_ON_START: false,
      DELIVERY_TIMEOUT_MS: options.deliveryTimeoutMs ?? 1_000,
      WORKER_CONCURRENCY: 2,
      // Fake receivers listen on 127.0.0.1 over http.
      ALLOW_PRIVATE_TARGETS: true,
      ALLOW_HTTP_TARGETS: true,
      EMAIL_FROM: 'WebhookRelay <relay@test.local>',
      TELEGRAM_API_URL: 'https://api.telegram.org',
    },
    (error) => {
      throw error;
    },
    {
      clock,
      pollingIntervalSeconds: 0.5,
      ...(options.random && { random: options.random }),
    },
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
