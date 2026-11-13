import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { inject } from 'vitest';

import { Database } from '../../src/infrastructure/db/database.js';
import { runMigrations } from '../../src/infrastructure/db/migrate.js';

export interface TestDatabase {
  readonly database: Database;
  readonly url: string;
  /** Deletes every row, keeping the schema. Call in beforeEach for test isolation within a file. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A fresh, fully migrated database dedicated to the calling test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const serverUrl = inject('postgresUrl');
  const name = `test_${randomUUID().replaceAll('-', '')}`;

  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const database = Database.connect(url.toString(), { max: 5 });
  await runMigrations(database.db);

  return {
    database,
    url: url.toString(),
    async reset() {
      await database.pool.query(
        'TRUNCATE delivery_attempts, deliveries, subscription_secrets, subscriptions, events CASCADE',
      );
    },
    async close() {
      await database.close();
    },
  };
}
