import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deliver } from '../../../src/application/deliver.js';
import { newId } from '../../../src/application/ids.js';
import { USER_AGENT } from '../../../src/composition.js';
import { verify } from '../../../src/domain/signature.js';
import { WebhookChannel } from '../../../src/infrastructure/channels/webhook.js';
import { minutesAfter, NOW } from '../../support/builders.js';
import { createTestApp, type TestApp } from '../../support/app.js';
import { FakeDestination } from '../../support/fake-destination.js';
import { FakeClock } from '../../support/fakes.js';

let t: TestApp;
let destination: FakeDestination;
let clock: FakeClock;
let admin: string;

beforeAll(async () => {
  clock = new FakeClock(NOW);
  t = await createTestApp({ clock });
  destination = await FakeDestination.start();
});

afterAll(async () => {
  await destination.close();
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  destination.reset();
  admin = await t.bearer('admin');
});

interface SubscriptionResponse {
  id: string;
  secret: string | null;
  isActive: boolean;
  eventTypes: string[];
}

async function createWebhook(overrides: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/subscriptions',
    headers: { authorization: admin },
    payload: {
      name: 'Partner',
      channel: 'webhook',
      target: destination.url,
      eventTypes: ['appointment.*'],
      ...overrides,
    },
  });
  return response;
}

async function publishEvent(externalId = newId()) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/events',
    headers: { authorization: await t.bearer('source', 'scheduling-api') },
    payload: {
      id: externalId,
      type: 'appointment.created',
      occurredAt: NOW.toISOString(),
      data: { appointmentId: 'a-1' },
    },
  });
  return response.json<{ id: string }>().id;
}

const deliverDeps = () => ({
  ...t.runtime.deliverDeps,
  clock,
  random: () => 0.5,
  channels: {
    webhook: new WebhookChannel({
      timeoutMs: 500,
      userAgent: USER_AGENT,
      allowPrivateNetworks: true,
    }),
  },
});

describe('authorization', () => {
  it.each([
    ['GET', '/subscriptions'],
    ['POST', '/subscriptions'],
    ['GET', '/deliveries'],
    ['POST', `/deliveries/${newId()}/replay`],
  ] as const)('%s %s needs an admin key', async (method, url) => {
    const anonymous = await t.app.inject({ method, url, payload: {} });
    const source = await t.app.inject({
      method,
      url,
      payload: {},
      headers: { authorization: await t.bearer('source', 'scheduling-api') },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(source.statusCode).toBe(403);
  });
});

describe('subscriptions', () => {
  it('creates a webhook subscription and shows its secret only in the creation response', async () => {
    const created = await createWebhook();

    expect(created.statusCode).toBe(201);
    const body = created.json<SubscriptionResponse>();
    expect(body.secret).toMatch(/^whsec_/);
    expect(created.headers.location).toBe(`/subscriptions/${body.id}`);

    const detail = await t.app.inject({
      url: `/subscriptions/${body.id}`,
      headers: { authorization: admin },
    });
    const list = await t.app.inject({ url: '/subscriptions', headers: { authorization: admin } });
    expect(detail.json()).not.toHaveProperty('secret');
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain(body.secret);
  });

  it('validates the body field by field', async () => {
    const response = await createWebhook({ name: '', channel: 'sms', eventTypes: [] });

    expect(response.statusCode).toBe(400);
    expect(Object.keys(response.json<{ errors: object }>().errors).sort()).toEqual([
      'channel',
      'eventTypes',
      'name',
    ]);
  });

  it('rejects an invalid event type pattern', async () => {
    const response = await createWebhook({ eventTypes: ['*.created'] });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed target with 400', async () => {
    const response = await createWebhook({ target: 'not-a-url' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'Subscription.InvalidTarget' });
  });

  it('deactivates a subscription so new events skip it', async () => {
    const { id } = (await createWebhook()).json<SubscriptionResponse>();

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/subscriptions/${id}`,
      headers: { authorization: admin },
      payload: { isActive: false },
    });
    const eventId = await publishEvent();

    expect(patched.json()).toMatchObject({ isActive: false });
    const event = await t.app.inject({
      url: `/events/${eventId}`,
      headers: { authorization: admin },
    });
    expect(event.json<{ deliveries: unknown[] }>().deliveries).toEqual([]);
  });

  it('rejects an empty PATCH', async () => {
    const { id } = (await createWebhook()).json<SubscriptionResponse>();

    const response = await t.app.inject({
      method: 'PATCH',
      url: `/subscriptions/${id}`,
      headers: { authorization: admin },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for an unknown subscription', async () => {
    const response = await t.app.inject({
      method: 'PATCH',
      url: `/subscriptions/${newId()}`,
      headers: { authorization: admin },
      payload: { isActive: false },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'Subscription.NotFound' });
  });

  it('rotates the secret: for 24 hours webhooks verify with either the old or the new one', async () => {
    const { id, secret: oldSecret } = (await createWebhook()).json<SubscriptionResponse>();

    const rotation = await t.app.inject({
      method: 'POST',
      url: `/subscriptions/${id}/rotate-secret`,
      headers: { authorization: admin },
    });
    expect(rotation.statusCode).toBe(200);
    const { secret: newSecret, previousSecretExpiresAt } = rotation.json<{
      secret: string;
      previousSecretExpiresAt: string;
    }>();
    expect(previousSecretExpiresAt).toBe(minutesAfter(NOW, 24 * 60).toISOString());

    const eventId = await publishEvent();
    const page = await t.runtime.database.repositories.deliveries.list({ eventId, limit: 1 });
    await deliver(page.items[0]?.id ?? '', deliverDeps());

    const [request] = destination.requests;
    const check = (secret: string | null) =>
      verify({
        secrets: [secret ?? ''],
        messageId: request?.headers['webhook-id'] as string,
        timestamp: request?.headers['webhook-timestamp'] as string,
        signature: request?.headers['webhook-signature'] as string,
        body: request?.body ?? '',
        now: NOW,
      }).ok;
    expect(check(oldSecret)).toBe(true);
    expect(check(newSecret)).toBe(true);
  });
});

describe('deliveries', () => {
  async function givenDeadDelivery() {
    await createWebhook();
    const eventId = await publishEvent();
    const page = await t.runtime.database.repositories.deliveries.list({ eventId, limit: 1 });
    const deliveryId = page.items[0]?.id ?? '';
    destination.respondWith({ status: 410, body: 'gone' });
    await deliver(deliveryId, deliverDeps());
    return deliveryId;
  }

  it('lists the dead-letter queue with status=dead', async () => {
    const deadId = await givenDeadDelivery();
    await publishEvent(); // a second, still pending delivery

    const response = await t.app.inject({
      url: '/deliveries?status=dead',
      headers: { authorization: admin },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ id: deadId, status: 'dead', attempts: 1, lastError: 'HTTP 410' }],
      nextCursor: null,
    });
  });

  it('paginates with a cursor and rejects a forged one', async () => {
    await createWebhook();
    for (let i = 0; i < 3; i++) await publishEvent();

    const first = await t.app.inject({
      url: '/deliveries?limit=2',
      headers: { authorization: admin },
    });
    const { nextCursor } = first.json<{ nextCursor: string }>();
    const second = await t.app.inject({
      url: `/deliveries?limit=2&cursor=${nextCursor}`,
      headers: { authorization: admin },
    });
    const forged = await t.app.inject({
      url: '/deliveries?cursor=abc',
      headers: { authorization: admin },
    });

    expect(first.json<{ items: unknown[] }>().items).toHaveLength(2);
    expect(second.json()).toMatchObject({ nextCursor: null });
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ code: 'Delivery.InvalidCursor' });
  });

  it('shows the attempt history', async () => {
    const deadId = await givenDeadDelivery();

    const response = await t.app.inject({
      url: `/deliveries/${deadId}/attempts`,
      headers: { authorization: admin },
    });

    expect(response.json()).toMatchObject({
      items: [{ attemptNumber: 1, httpStatus: 410, error: 'HTTP 410', responseSnippet: 'gone' }],
    });
  });

  it('replays a dead delivery: 202, back to pending, a new job, then delivered (D6)', async () => {
    const deadId = await givenDeadDelivery();
    clock.advanceMinutes(60);

    const replay = await t.app.inject({
      method: 'POST',
      url: `/deliveries/${deadId}/replay`,
      headers: { authorization: admin },
    });

    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    const jobs = (await t.queuedJobs()).filter((job) => job.deliveryId === deadId);
    expect(jobs.map((job) => job.startAfter)).toContainEqual(minutesAfter(NOW, 60));

    const outcome = await deliver(deadId, deliverDeps());
    expect(outcome).toMatchObject({ delivery: { status: 'succeeded', attempts: 1 } });
    const history = await t.runtime.database.repositories.attempts.listByDelivery(deadId);
    expect(history.map((attempt) => attempt.httpStatus)).toEqual([410, 200]);
  });

  it('refuses to replay a delivery that is not dead (409)', async () => {
    await createWebhook();
    const eventId = await publishEvent();
    const page = await t.runtime.database.repositories.deliveries.list({ eventId, limit: 1 });

    const response = await t.app.inject({
      method: 'POST',
      url: `/deliveries/${page.items[0]?.id ?? ''}/replay`,
      headers: { authorization: admin },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'Delivery.NotDead' });
  });

  it('returns 404 for an unknown delivery', async () => {
    const response = await t.app.inject({
      url: `/deliveries/${newId()}/attempts`,
      headers: { authorization: admin },
    });

    expect(response.statusCode).toBe(404);
  });
});
