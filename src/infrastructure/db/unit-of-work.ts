import type { PgBoss } from 'pg-boss';

import type { TransactionContext, UnitOfWork } from '../../application/ports.js';
import { PgBossDeliveryQueue } from '../queue/delivery-queue.js';
import type { Database } from './database.js';

/** One PostgreSQL transaction covering the repositories and the pg-boss job table. */
export class PgUnitOfWork implements UnitOfWork {
  constructor(
    private readonly database: Database,
    private readonly boss: PgBoss,
  ) {}

  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.database.transaction(({ repositories, executeSql }) =>
      work({ repositories, queue: new PgBossDeliveryQueue(this.boss, executeSql) }),
    );
  }
}
