import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../../src/application/ids.js';
import { systemClock } from '../../../src/composition.js';
import { buildApp } from '../../../src/http/app.js';
import { generateSecret } from '../../../src/domain/signature.js';
import { aSubscription, NOW } from '../../support/builders.js';
import { createTestApp, type TestApp } from '../../support/app.js';
import { FakeDestination } from '../../support/fake-destination.js';

let t: TestApp;
let destination: FakeDestination;

beforeAll(async () => {
  t = await createTestApp({ clock: systemClock });
  destination = await FakeDestination.start();
});

afterAll(async () => {
  await destination.close();
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  destination.reset();
});

async function publish(id = newId()) {
  return t.app.inject({
    method: 'POST',
    url: '/events',
    headers: { authorization: await t.bearer('source', 'scheduling-api') },
    payload: { id, type: 'appointment.created', occurredAt: new Date().toISOString(), data: {} },
  });
}

describe('GET /metrics', () => {
  it('exposes events, queue depth and HTTP latency by route template', async () => {
    await t.runtime.database.repositories.subscriptions.insert(
      aSubscription({ id: newId(), target: destination.url, eventTypes: ['*'] }),
    );
    await publish('m-1');
    await publish('m-1');

    const response = await t.app.inject('/metrics');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const text = response.body;
    expect(text).toContain('events_received_total{source="scheduling-api",duplicate="false"} 1');
    expect(text).toContain('events_received_total{source="scheduling-api",duplicate="true"} 1');
    expect(text).toContain('queue_depth{state="created"} 1');
    expect(text).toMatch(
      /http_request_duration_seconds_count\{method="POST",route="\/events",status_code="202"\} \d+/,
    );
    expect(text).toContain('process_cpu_seconds_total');
  });

  it('requires the token when one is configured', async () => {
    const app = await buildApp(
      { LOG_LEVEL: 'silent', METRICS_TOKEN: 'a-long-metrics-token' },
      t.runtime.app,
    );
    try {
      const anonymous = await app.inject('/metrics');
      const authorized = await app.inject({
        url: '/metrics',
        headers: { authorization: 'Bearer a-long-metrics-token' },
      });

      expect(anonymous.statusCode).toBe(401);
      expect(authorized.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('OpenAPI', () => {
  it('describes every route from the Zod schemas, with bearer authentication', async () => {
    const response = await t.app.inject('/openapi.json');

    expect(response.statusCode).toBe(200);
    const spec = response.json<{
      paths: Record<string, Record<string, { security?: unknown[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    }>();
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/deliveries',
      '/deliveries/{id}',
      '/deliveries/{id}/attempts',
      '/deliveries/{id}/replay',
      '/events',
      '/events/{id}',
      '/health',
      '/subscriptions',
      '/subscriptions/{id}',
      '/subscriptions/{id}/rotate-secret',
    ]);
    expect(spec.components.securitySchemes).toHaveProperty('apiKey');
    expect(spec.paths['/health']?.get?.security).toEqual([]);
  });

  it('serves the Scalar reference at /docs', async () => {
    const response = await t.app.inject('/docs/');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });
});

describe('graceful shutdown', () => {
  it('finishes the delivery in progress before closing, so it is not lost', async () => {
    const shuttingDown = await createTestApp({ clock: systemClock });
    const secret = generateSecret();
    const subscription = aSubscription({ id: newId(), target: destination.url, eventTypes: ['*'] });
    await shuttingDown.runtime.database.repositories.subscriptions.insert(subscription);
    await shuttingDown.runtime.database.repositories.subscriptions.addSecret(subscription.id, {
      id: newId(),
      value: secret,
      createdAt: NOW,
    });
    // The receiver takes 800 ms: SIGTERM arrives while the request is in flight.
    destination.respondWith({ status: 200, delayMs: 800 });
    await shuttingDown.runtime.startWorker();

    const response = await shuttingDown.app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: await shuttingDown.bearer('source', 'scheduling-api') },
      payload: {
        id: 'stop-1',
        type: 'appointment.created',
        occurredAt: new Date().toISOString(),
        data: {},
      },
    });
    const eventId = response.json<{ id: string }>().id;
    await destination.waitForRequests(1);

    await shuttingDown.close();

    // The pool is closed now; read the outcome with a fresh connection.
    const client = new pg.Client({ connectionString: shuttingDown.testDb.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM deliveries WHERE event_id = $1',
        [eventId],
      );
      expect(rows).toEqual([{ status: 'succeeded', attempts: 1 }]);
    } finally {
      await client.end();
    }
  });
});
