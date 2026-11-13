import type { PgBoss } from 'pg-boss';

import { newId } from './application/ids.js';
import type { Config } from './config.js';
import type { Clock } from './domain/clock.js';
import type { AppDependencies } from './http/app.js';
import { Database } from './infrastructure/db/database.js';
import { runMigrations } from './infrastructure/db/migrate.js';
import { PgUnitOfWork } from './infrastructure/db/unit-of-work.js';
import { startBoss } from './infrastructure/queue/delivery-queue.js';

export const systemClock: Clock = { now: () => new Date() };

/** The composition root: the only place that knows which implementation backs each port. */
export interface Runtime {
  readonly database: Database;
  readonly boss: PgBoss;
  readonly app: AppDependencies;
  close(): Promise<void>;
}

export async function createRuntime(
  config: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_SIZE' | 'MIGRATE_ON_START'>,
  onError: (error: Error) => void,
  clock: Clock = systemClock,
): Promise<Runtime> {
  const database = Database.connect(config.DATABASE_URL, { max: config.DATABASE_POOL_SIZE });
  if (config.MIGRATE_ON_START) await runMigrations(database.db);
  const boss = await startBoss(config.DATABASE_URL, onError);

  return {
    database,
    boss,
    app: {
      clock,
      newId,
      unitOfWork: new PgUnitOfWork(database, boss),
      repositories: database.repositories,
      checkDatabase: async () => {
        await database.pool.query('SELECT 1');
        return true;
      },
    },
    async close() {
      await boss.stop({ graceful: true });
      await database.close();
    },
  };
}
