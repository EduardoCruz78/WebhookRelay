import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deliver, type DeliverDeps } from '../../../src/application/deliver.js';
import { newId } from '../../../src/application/ids.js';
import { ingestEvent } from '../../../src/application/ingest-event.js';
import type { Repositories } from '../../../src/application/ports.js';
import type { Subscription } from '../../../src/domain/subscription.js';
import { generateSecret, verify } from '../../../src/domain/signature.js';
import { USER_AGENT } from '../../../src/composition.js';
import { WebhookChannel } from '../../../src/infrastructure/channels/webhook.js';
import { aSubscription, NOW } from '../../support/builders.js';
import { createTestApp, type TestApp } from '../../support/app.js';
import { FakeDestination } from '../../support/fake-destination.js';
import { FakeClock } from '../../support/fakes.js';

const TIMEOUT_MS = 300;

let t: TestApp;
let destination: FakeDestination;
let clock: FakeClock;
let deps: DeliverDeps;
let repos: Repositories;

beforeAll(async () => {
  clock = new FakeClock(NOW);
  t = await createTestApp({ clock });
  destination = await FakeDestination.start();
  repos = t.runtime.database.repositories;
  deps = {
    ...t.runtime.deliverDeps,
    clock,
    // random 0.5: every retry waits exactly half of its backoff ceiling.
    random: () => 0.5,
    channels: {
      webhook: new WebhookChannel({
        timeoutMs: TIMEOUT_MS,
        userAgent: USER_AGENT,
        allowPrivateNetworks: true,
      }),
    },
  };
});

afterAll(async () => {
  await destination.close();
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  destination.reset();
  clock = new FakeClock(NOW);
  deps = { ...deps, clock };
});

async function givenSubscription(overrides: Partial<Subscription> = {}) {
  const secret = generateSecret();
  const subscription = aSubscription({
    id: newId(),
    target: destination.url,
    eventTypes: ['*'],
    ...overrides,
  });
  await repos.subscriptions.insert(subscription);
  await repos.subscriptions.addSecret(subscription.id, {
    id: newId(),
    value: secret,
    createdAt: NOW,
  });
  return { subscription, secret };
}

/** Publishes an event and returns the id of its single delivery. */
async function givenDelivery(overrides: Partial<Subscription> = {}) {
  const { subscription, secret } = await givenSubscription(overrides);
  const result = await ingestEvent(
    {
      source: 'scheduling-api',
      externalId: newId(),
      type: 'appointment.created',
      occurredAt: NOW,
      data: { appointmentId: 'a-1' },
    },
    { unitOfWork: t.runtime.app.unitOfWork, clock, newId },
  );
  const page = await repos.deliveries.list({ eventId: result.event.id, limit: 1 });
  const delivery = page.items[0];
  if (!delivery) throw new Error('no delivery created');
  return { deliveryId: delivery.id, eventId: result.event.id, subscription, secret };
}

const retryJobs = async (deliveryId: string) =>
  (await t.queuedJobs()).filter((job) => job.deliveryId === deliveryId).slice(1);

describe('deliver: success', () => {
  it('POSTs the signed event and marks the delivery succeeded (D3, D8)', async () => {
    const { deliveryId, eventId, secret } = await givenDelivery();

    const outcome = await deliver(deliveryId, deps);

    expect(outcome).toMatchObject({
      kind: 'attempted',
      delivery: { status: 'succeeded', attempts: 1 },
    });
    const [request] = destination.requests;
    expect(request?.method).toBe('POST');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['user-agent']).toBe(USER_AGENT);
    expect(request?.headers['webhook-id']).toBe(eventId);
    expect(request?.headers['webhook-timestamp']).toBe(String(NOW.getTime() / 1000));
    expect(JSON.parse(request?.body ?? '')).toEqual({
      id: eventId,
      type: 'appointment.created',
      source: 'scheduling-api',
      occurredAt: NOW.toISOString(),
      data: { appointmentId: 'a-1' },
    });

    // What a receiver does with the shared secret:
    const verification = verify({
      secrets: [secret],
      messageId: request?.headers['webhook-id'] as string,
      timestamp: request?.headers['webhook-timestamp'] as string,
      signature: request?.headers['webhook-signature'] as string,
      body: request?.body ?? '',
      now: NOW,
    });
    expect(verification.ok).toBe(true);
  });

  it('records the attempt with status, duration and response snippet', async () => {
    const { deliveryId } = await givenDelivery();
    destination.respondWith({ status: 202, body: '{"received":true}' });

    await deliver(deliveryId, deps);

    const [attempt] = await repos.attempts.listByDelivery(deliveryId);
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      startedAt: NOW,
      httpStatus: 202,
      error: null,
      responseSnippet: '{"received":true}',
    });
    expect(attempt?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps only the first 1 KB of a large response body', async () => {
    const { deliveryId } = await givenDelivery();
    destination.respondWith({ status: 200, body: 'x'.repeat(100_000) });

    await deliver(deliveryId, deps);

    const [attempt] = await repos.attempts.listByDelivery(deliveryId);
    expect(attempt?.responseSnippet).toHaveLength(1024);
  });
});

describe('deliver: retries', () => {
  it('500, 500, 200: three attempts, two scheduled retries, then succeeded (D4)', async () => {
    const { deliveryId } = await givenDelivery();
    destination.respondWith({ status: 500 }, { status: 500 });

    const first = await deliver(deliveryId, deps);
    expect(first).toMatchObject({
      delivery: { status: 'failed', attempts: 1, lastError: 'HTTP 500' },
    });
    // Ceiling after attempt 1 is 30 s; random 0.5 gives 15 s.
    expect((await repos.deliveries.findById(deliveryId))?.nextAttemptAt).toEqual(
      new Date(NOW.getTime() + 15_000),
    );

    clock.advanceMinutes(0.25);
    const second = await deliver(deliveryId, deps);
    expect(second).toMatchObject({ delivery: { status: 'failed', attempts: 2 } });

    clock.advanceMinutes(1);
    const third = await deliver(deliveryId, deps);
    expect(third).toMatchObject({
      delivery: { status: 'succeeded', attempts: 3, lastError: null },
    });

    const history = await repos.attempts.listByDelivery(deliveryId);
    expect(history.map((a) => a.httpStatus)).toEqual([500, 500, 200]);
    expect(destination.requests).toHaveLength(3);
    // The webhook-id stays the same on every retry, so the receiver can deduplicate (D9).
    expect(new Set(destination.requests.map((r) => r.headers['webhook-id'])).size).toBe(1);

    const retries = await retryJobs(deliveryId);
    expect(retries.map((job) => job.startAfter.getTime()).sort()).toEqual([
      NOW.getTime() + 15_000,
      NOW.getTime() + 15_000 + 60_000,
    ]);
  });

  it('dead-letters after 8 failed attempts (D6)', async () => {
    const { deliveryId } = await givenDelivery();
    destination.respondWith(...Array.from({ length: 8 }, () => ({ status: 503 })));

    for (let attempt = 1; attempt <= 8; attempt++) {
      await deliver(deliveryId, deps);
      clock.advanceMinutes(6 * 60);
    }

    const delivery = await repos.deliveries.findById(deliveryId);
    expect(delivery).toMatchObject({
      status: 'dead',
      attempts: 8,
      lastError: 'HTTP 503 (gave up after 8 attempts)',
    });
    expect(await retryJobs(deliveryId)).toHaveLength(7);
    expect(await repos.attempts.listByDelivery(deliveryId)).toHaveLength(8);
  });

  it('respects Retry-After on 429 (D7)', async () => {
    const { deliveryId } = await givenDelivery();
    destination.respondWith({ status: 429, headers: { 'retry-after': '120' } });

    await deliver(deliveryId, deps);

    expect((await repos.deliveries.findById(deliveryId))?.nextAttemptAt).toEqual(
      new Date(NOW.getTime() + 120_000),
    );
  });

  it('treats a destination slower than the timeout as a retryable failure', async () => {
    const { deliveryId } = await givenDelivery();
    destination.respondWith({ status: 200, delayMs: TIMEOUT_MS * 4 });

    const outcome = await deliver(deliveryId, deps);

    expect(outcome).toMatchObject({
      delivery: { status: 'failed', lastError: `Timed out after ${TIMEOUT_MS} ms` },
    });
    const [attempt] = await repos.attempts.listByDelivery(deliveryId);
    expect(attempt?.httpStatus).toBeNull();
    expect(attempt?.durationMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(attempt?.durationMs).toBeLessThan(TIMEOUT_MS * 4);
  });

  it('treats a refused connection as a retryable network error', async () => {
    const closed = await FakeDestination.start();
    const url = closed.url;
    await closed.close();
    const { deliveryId } = await givenDelivery({ target: url });

    const outcome = await deliver(deliveryId, deps);

    expect(outcome).toMatchObject({ delivery: { status: 'failed' } });
    expect((await repos.deliveries.findById(deliveryId))?.lastError).toContain('ECONNREFUSED');
  });
});

describe('deliver: permanent failures (D5)', () => {
  it('dead-letters a 400 at once, without scheduling a retry', async () => {
    const { deliveryId } = await givenDelivery();
    destination.respondWith({ status: 400, body: '{"error":"bad payload"}' });

    const outcome = await deliver(deliveryId, deps);

    expect(outcome).toMatchObject({
      delivery: { status: 'dead', attempts: 1, lastError: 'HTTP 400' },
    });
    expect(await retryJobs(deliveryId)).toEqual([]);
    const [attempt] = await repos.attempts.listByDelivery(deliveryId);
    expect(attempt?.responseSnippet).toBe('{"error":"bad payload"}');
  });

  it('does not follow redirects', async () => {
    const elsewhere = await FakeDestination.start();
    try {
      const { deliveryId } = await givenDelivery();
      destination.respondWith({ status: 302, headers: { location: elsewhere.url } });

      const outcome = await deliver(deliveryId, deps);

      expect(outcome).toMatchObject({ delivery: { status: 'dead', lastError: 'HTTP 302' } });
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      await elsewhere.close();
    }
  });
});

describe('deliver: guards', () => {
  it('abandons the delivery without calling anyone when the subscription was deactivated', async () => {
    const { deliveryId, subscription } = await givenDelivery();
    await repos.subscriptions.update({ ...subscription, isActive: false });

    const outcome = await deliver(deliveryId, deps);

    expect(outcome).toMatchObject({
      kind: 'abandoned',
      delivery: { status: 'dead', lastError: 'Subscription is inactive or was deleted' },
    });
    expect(destination.requests).toHaveLength(0);
  });

  it('abandons the delivery when its channel is not configured', async () => {
    const { deliveryId } = await givenDelivery({ channel: 'telegram', target: '12345' });

    const outcome = await deliver(deliveryId, deps);

    expect(outcome).toMatchObject({
      kind: 'abandoned',
      delivery: { lastError: "Channel 'telegram' is not configured" },
    });
  });

  it('skips a delivery that is already final', async () => {
    const { deliveryId } = await givenDelivery();
    await deliver(deliveryId, deps);

    const again = await deliver(deliveryId, deps);

    expect(again).toEqual({ kind: 'skipped', reason: 'already succeeded' });
    expect(destination.requests).toHaveLength(1);
  });

  it('skips a stale job that arrives before the retry is due', async () => {
    const { deliveryId } = await givenDelivery();
    destination.respondWith({ status: 500 });
    await deliver(deliveryId, deps);

    const early = await deliver(deliveryId, deps);

    expect(early).toEqual({ kind: 'skipped', reason: 'not due yet' });
    expect(destination.requests).toHaveLength(1);
  });

  it('records only one attempt when two workers race on the same delivery', async () => {
    const { deliveryId } = await givenDelivery();

    const outcomes = await Promise.all([deliver(deliveryId, deps), deliver(deliveryId, deps)]);

    // Both may reach the destination (at-least-once), but the history stays consistent.
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['attempted', 'skipped']);
    expect(await repos.attempts.listByDelivery(deliveryId)).toHaveLength(1);
  });

  it('skips an unknown delivery', async () => {
    expect(await deliver(newId(), deps)).toEqual({ kind: 'skipped', reason: 'unknown delivery' });
  });
});
