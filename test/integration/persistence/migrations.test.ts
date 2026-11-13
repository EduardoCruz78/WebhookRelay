import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/infrastructure/db/migrate.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

describe('migrations', () => {
  it('create every table from scratch', async () => {
    const { rows } = await testDb.database.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );

    expect(rows.map((row) => row.table_name)).toEqual([
      'deliveries',
      'delivery_attempts',
      'events',
      'subscription_secrets',
      'subscriptions',
    ]);
  });

  it('are idempotent: running them again changes nothing', async () => {
    await expect(runMigrations(testDb.database.db)).resolves.toBeUndefined();

    const { rows } = await testDb.database.pool.query<{ count: string }>(
      'SELECT count(*) FROM drizzle.__drizzle_migrations',
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});
