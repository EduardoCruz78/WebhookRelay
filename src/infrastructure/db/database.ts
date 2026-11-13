import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { Repositories } from '../../application/ports.js';
import { createRepositories } from './repositories.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/** Runs raw SQL on the transaction's connection. Same shape pg-boss accepts as its `db` option. */
export type ExecuteSql = (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;

export interface TransactionScope {
  readonly repositories: Repositories;
  readonly executeSql: ExecuteSql;
}

export class Database {
  readonly db: Db;
  readonly repositories: Repositories;

  constructor(readonly pool: pg.Pool) {
    this.db = drizzle({ client: pool, schema });
    this.repositories = createRepositories(this.db);
  }

  static connect(connectionString: string, options: { max?: number } = {}): Database {
    return new Database(new pg.Pool({ connectionString, max: options.max ?? 10 }));
  }

  /**
   * Runs `work` inside one PostgreSQL transaction on a dedicated connection. Anything that uses
   * the scope (repositories, or other libraries through `executeSql`) commits or rolls back together.
   */
  async transaction<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const db = drizzle({ client, schema });
      const result = await work({
        repositories: createRepositories(db),
        executeSql: (text, values) => client.query(text, values),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The connection is unusable; release(error) below destroys it instead of pooling it.
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
