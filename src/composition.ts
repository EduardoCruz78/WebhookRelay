import { randomInt } from 'node:crypto';

import type { PgBoss } from 'pg-boss';

import { deliver, type DeliverDeps, type DeliverOutcome } from './application/deliver.js';
import { newId } from './application/ids.js';
import type { Channels } from './application/ports.js';
import type { Config } from './config.js';
import type { Clock, RandomSource } from './domain/clock.js';
import type { AppDependencies } from './http/app.js';
import { checkHost } from './infrastructure/channels/ssrf.js';
import { WebhookChannel } from './infrastructure/channels/webhook.js';
import { Database } from './infrastructure/db/database.js';
import { runMigrations } from './infrastructure/db/migrate.js';
import { PgUnitOfWork } from './infrastructure/db/unit-of-work.js';
import { startBoss, startDeliveryWorker } from './infrastructure/queue/delivery-queue.js';

export const systemClock: Clock = { now: () => new Date() };

/** Uniform in [0, 1) from the CSPRNG; Math.random would do for jitter, but this costs nothing. */
export const systemRandom: RandomSource = () => randomInt(0, 2 ** 32) / 2 ** 32;

export const USER_AGENT = 'WebhookRelay/0.1 (+https://github.com/EduardoCruz78/WebhookRelay)';

export type RuntimeConfig = Pick<
  Config,
  | 'DATABASE_URL'
  | 'DATABASE_POOL_SIZE'
  | 'MIGRATE_ON_START'
  | 'DELIVERY_TIMEOUT_MS'
  | 'WORKER_CONCURRENCY'
  | 'ALLOW_PRIVATE_TARGETS'
  | 'ALLOW_HTTP_TARGETS'
>;

export interface RuntimeOverrides {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly channels?: Channels;
  /** Faster polling in tests; pg-boss defaults to 2 s. */
  readonly pollingIntervalSeconds?: number;
}

/** The composition root: the only place that knows which implementation backs each port. */
export interface Runtime {
  readonly database: Database;
  readonly boss: PgBoss;
  readonly app: AppDependencies;
  readonly deliverDeps: DeliverDeps;
  /** Starts consuming the delivery queue in this process. */
  startWorker(onDelivered?: (outcome: DeliverOutcome) => void): Promise<void>;
  close(): Promise<void>;
}

export async function createRuntime(
  config: RuntimeConfig,
  onError: (error: Error) => void,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  const clock = overrides.clock ?? systemClock;
  const database = Database.connect(config.DATABASE_URL, { max: config.DATABASE_POOL_SIZE });
  if (config.MIGRATE_ON_START) await runMigrations(database.db);
  const boss = await startBoss(config.DATABASE_URL, onError);
  const unitOfWork = new PgUnitOfWork(database, boss);

  const deliverDeps: DeliverDeps = {
    repositories: database.repositories,
    unitOfWork,
    channels: overrides.channels ?? {
      webhook: new WebhookChannel({
        timeoutMs: config.DELIVERY_TIMEOUT_MS,
        userAgent: USER_AGENT,
        allowPrivateNetworks: config.ALLOW_PRIVATE_TARGETS,
      }),
    },
    clock,
    random: overrides.random ?? systemRandom,
    newId,
  };

  return {
    database,
    boss,
    deliverDeps,
    app: {
      clock,
      newId,
      unitOfWork,
      repositories: database.repositories,
      checkDatabase: async () => {
        await database.pool.query('SELECT 1');
        return true;
      },
      targetPolicy: {
        allowPrivateNetworks: config.ALLOW_PRIVATE_TARGETS,
        allowHttp: config.ALLOW_HTTP_TARGETS,
      },
      checkHost,
    },
    async startWorker(onDelivered) {
      await startDeliveryWorker(
        boss,
        async (deliveryId) => {
          const outcome = await deliver(deliveryId, deliverDeps);
          onDelivered?.(outcome);
        },
        {
          concurrency: config.WORKER_CONCURRENCY,
          ...(overrides.pollingIntervalSeconds !== undefined && {
            pollingIntervalSeconds: overrides.pollingIntervalSeconds,
          }),
        },
      );
    },
    async close() {
      // graceful: stop fetching new jobs and wait for the ones in progress before closing.
      await boss.stop({ graceful: true, timeout: config.DELIVERY_TIMEOUT_MS + 5_000 });
      await database.close();
    },
  };
}
