import { PgBoss } from 'pg-boss';

import type { DeliveryJob, DeliveryQueue } from '../../application/ports.js';
import type { ExecuteSql } from '../db/database.js';

export const DELIVERY_QUEUE = 'deliveries';

export interface DeliveryJobData {
  readonly deliveryId: string;
}

/**
 * Starts pg-boss on the same PostgreSQL database (its tables live in the `pgboss` schema) and
 * makes sure the delivery queue exists. Safe to call from several processes at once.
 */
export async function startBoss(
  connectionString: string,
  onError: (error: Error) => void,
): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', onError);
  await boss.start();
  await boss.createQueue(DELIVERY_QUEUE, {
    // Retries are decided by the domain (backoff, Retry-After, dead-letter), not by pg-boss.
    // pg-boss only re-runs a job whose worker crashed or was killed mid-delivery: the job
    // expires after expireInSeconds and goes back to the queue (at-least-once).
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 60,
  });
  return boss;
}

/** Enqueues through the caller's transaction, so jobs exist only if that transaction commits. */
export class PgBossDeliveryQueue implements DeliveryQueue {
  constructor(
    private readonly boss: PgBoss,
    private readonly executeSql?: ExecuteSql,
  ) {}

  async enqueue(jobs: readonly DeliveryJob[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.boss.insert(
      DELIVERY_QUEUE,
      jobs.map((job) => ({
        data: { deliveryId: job.deliveryId } satisfies DeliveryJobData,
        startAfter: job.runAt,
      })),
      this.executeSql ? { db: { executeSql: this.executeSql } } : {},
    );
  }
}
