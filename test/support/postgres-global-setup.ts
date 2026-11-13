import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}

/**
 * Starts one throwaway PostgreSQL 17 container for the whole integration run. Each test file
 * then creates its own database inside it (see createTestDatabase), so files run in parallel
 * without sharing rows.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('postgres')
    .start();
  project.provide('postgresUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
