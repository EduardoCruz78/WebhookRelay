import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../../src/application/ids.js';
import { ingestEvent } from '../../../src/application/ingest-event.js';
import { aSubscription, NOW } from '../../support/builders.js';
import { createTestApp, type TestApp } from '../../support/app.js';

let t: TestApp;
let sourceKey: string;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  sourceKey = await t.bearer('source', 'scheduling-api');
});

const body = (overrides: Record<string, unknown> = {}) => ({
  id: 'outbox-1',
  type: 'appointment.created',
  occurredAt: '2026-12-07T11:59:00Z',
  data: { appointmentId: 'a-1', startsAt: '2026-12-08T13:00:00Z' },
  ...overrides,
});

function publish(payload: unknown, authorization: string | null = sourceKey) {
  return t.app.inject({
    method: 'POST',
    url: '/events',
    headers: authorization ? { authorization } : {},
    payload: payload as Record<string, unknown>,
  });
}

async function givenSubscriptions(count: number, eventTypes = ['appointment.*']) {
  for (let i = 0; i < count; i++) {
    await t.runtime.database.repositories.subscriptions.insert(
      aSubscription({ id: newId(), name: `sub ${i}`, eventTypes }),
    );
  }
}

describe('POST /events: authentication', () => {
  it('rejects a request without an API key with 401 and WWW-Authenticate', async () => {
    const response = await publish(body(), null);

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.json()).toMatchObject({ status: 401, code: 'Auth.Unauthenticated' });
  });

  it('checks the key before validating the body: no schema details for anonymous callers', async () => {
    const response = await publish({ nonsense: true }, null);

    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown key exactly like a missing one', async () => {
    const response = await publish(body(), 'Bearer wr_not-a-real-key');

    expect(response.statusCode).toBe(401);
  });

  it('rejects an admin key: only source keys publish events (403)', async () => {
    const response = await publish(body(), await t.bearer('admin'));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'Auth.Forbidden' });
  });
});

describe('POST /events: validation', () => {
  it('returns 400 problem details with one entry per invalid field', async () => {
    const response = await publish({
      id: '',
      type: 'Appointment Created',
      occurredAt: 'yesterday',
      data: [1, 2],
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json<{ code: string; errors: Record<string, string[]> }>();
    expect(problem.code).toBe('Request.Invalid');
    expect(Object.keys(problem.errors).sort()).toEqual(['data', 'id', 'occurredAt', 'type']);
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: sourceKey, 'content-type': 'application/json' },
      payload: '{"id": ',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 400 });
  });

  it('rejects a body larger than 256 KB with 413', async () => {
    const response = await publish(body({ data: { blob: 'x'.repeat(300 * 1024) } }));

    expect(response.statusCode).toBe(413);
  });
});

describe('POST /events: ingestion', () => {
  it('accepts a new event with 202, fans it out and enqueues one job per delivery', async () => {
    await givenSubscriptions(2);

    const response = await publish(body());

    expect(response.statusCode).toBe(202);
    const created = response.json<{ id: string; deliveryCount: number }>();
    expect(created).toMatchObject({
      source: 'scheduling-api',
      type: 'appointment.created',
      externalId: 'outbox-1',
      occurredAt: '2026-12-07T11:59:00.000Z',
      receivedAt: NOW.toISOString(),
      duplicate: false,
      deliveryCount: 2,
    });
    expect(response.headers.location).toBe(`/events/${created.id}`);

    const deliveries = await t.runtime.database.repositories.deliveries.list({
      eventId: created.id,
      limit: 10,
    });
    const jobs = await t.queuedJobs();
    expect(jobs.map((job) => job.deliveryId).sort()).toEqual(
      deliveries.items.map((delivery) => delivery.id).sort(),
    );
  });

  it('answers a repeated event with 200 and creates nothing new (D1)', async () => {
    await givenSubscriptions(1);
    const first = await publish(body());

    const second = await publish(body({ data: { changed: true } }));

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: first.json<{ id: string }>().id, duplicate: true });
    expect(await t.queuedJobs()).toHaveLength(1);
  });

  it('lets exactly one of many concurrent identical requests create the event', async () => {
    await givenSubscriptions(1);

    const responses = await Promise.all(Array.from({ length: 8 }, () => publish(body())));

    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 202]);
    expect(await t.queuedJobs()).toHaveLength(1);
  });

  it('stamps the source of the API key, ignoring any source in the body', async () => {
    const response = await publish(body({ source: 'billing' }));

    expect(response.json()).toMatchObject({ source: 'scheduling-api' });
  });

  it('keeps events of different sources apart even with the same id', async () => {
    await publish(body());

    const response = await publish(body(), await t.bearer('source', 'billing'));

    expect(response.statusCode).toBe(202);
  });

  it('rolls back the event and its deliveries if enqueuing fails', async () => {
    await givenSubscriptions(1);
    const { database } = t.runtime;
    const failingUnitOfWork = {
      run: <T>(work: Parameters<typeof t.runtime.app.unitOfWork.run<T>>[0]) =>
        database.transaction(({ repositories }) =>
          work({ repositories, queue: { enqueue: () => Promise.reject(new Error('queue down')) } }),
        ),
    };

    await expect(
      ingestEvent(
        {
          source: 'scheduling-api',
          externalId: 'atomic',
          type: 'appointment.created',
          occurredAt: NOW,
          data: {},
        },
        { unitOfWork: failingUnitOfWork, clock: t.clock, newId },
      ),
    ).rejects.toThrow('queue down');

    const { rows } = await database.pool.query('SELECT count(*)::int AS n FROM events');
    expect(rows[0]).toEqual({ n: 0 });
    const deliveries = await database.repositories.deliveries.list({ limit: 10 });
    expect(deliveries.items).toEqual([]);
  });
});

describe('GET /events/:id', () => {
  async function givenPublishedEvent() {
    await givenSubscriptions(2);
    const response = await publish(body());
    return response.json<{ id: string }>().id;
  }

  it('shows the event, its payload and its deliveries to an admin', async () => {
    const id = await givenPublishedEvent();

    const response = await t.app.inject({
      url: `/events/${id}`,
      headers: { authorization: await t.bearer('admin') },
    });

    expect(response.statusCode).toBe(200);
    const detail = response.json<{ data: unknown; deliveries: { status: string }[] }>();
    expect(detail.data).toEqual(body().data);
    expect(detail.deliveries).toHaveLength(2);
    expect(detail.deliveries.every((d) => d.status === 'pending')).toBe(true);
  });

  it('shows a source its own events', async () => {
    const id = await givenPublishedEvent();

    const response = await t.app.inject({
      url: `/events/${id}`,
      headers: { authorization: sourceKey },
    });

    expect(response.statusCode).toBe(200);
  });

  it("hides another source's events behind a 404", async () => {
    const id = await givenPublishedEvent();

    const response = await t.app.inject({
      url: `/events/${id}`,
      headers: { authorization: await t.bearer('source', 'billing') },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'Event.NotFound' });
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const admin = await t.bearer('admin');

    const unknown = await t.app.inject({
      url: `/events/${newId()}`,
      headers: { authorization: admin },
    });
    const malformed = await t.app.inject({ url: '/events/123', headers: { authorization: admin } });

    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(400);
  });
});
