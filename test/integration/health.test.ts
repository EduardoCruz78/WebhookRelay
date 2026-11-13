import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/http/app.js';
import { NOW } from '../support/builders.js';
import { FakeClock, FakeStore, sequentialIds } from '../support/fakes.js';

let app: FastifyInstance | undefined;

async function appWithDatabase(checkDatabase: () => Promise<boolean>) {
  const store = new FakeStore();
  app = await buildApp(
    { LOG_LEVEL: 'silent' },
    {
      clock: new FakeClock(NOW),
      newId: sequentialIds(),
      unitOfWork: store.unitOfWork,
      repositories: store.repositories,
      checkDatabase,
    },
  );
  return app;
}

afterEach(async () => {
  await app?.close();
});

describe('GET /health', () => {
  it('returns 200 when the database answers', async () => {
    const response = await (await appWithDatabase(async () => true)).inject('/health');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: true } });
  });

  it('returns 503 when the database is unreachable, so the platform stops routing traffic', async () => {
    const down = () => Promise.reject(new Error('ECONNREFUSED'));

    const response = await (await appWithDatabase(down)).inject('/health');

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', checks: { database: false } });
  });

  it('needs no API key', async () => {
    const response = await (await appWithDatabase(async () => true)).inject('/health');

    expect(response.statusCode).not.toBe(401);
  });
});

describe('unknown routes', () => {
  it('answer 404 as problem details', async () => {
    const response = await (await appWithDatabase(async () => true)).inject('/nope');

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 404,
      code: 'Route.NotFound',
      instance: '/nope',
    });
  });
});
