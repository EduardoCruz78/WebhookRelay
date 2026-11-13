import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '../../../src/application/ids.js';
import { systemClock } from '../../../src/composition.js';
import type { Delivery } from '../../../src/domain/delivery.js';
import { generateSecret, verify } from '../../../src/domain/signature.js';
import { aSubscription, NOW } from '../../support/builders.js';
import { createTestApp, type TestApp } from '../../support/app.js';
import { FakeDestination } from '../../support/fake-destination.js';

/**
 * The whole pipeline with real time: HTTP ingestion → transaction → pg-boss job → worker →
 * signed webhook → retry job → second attempt → succeeded.
 */
let t: TestApp;
let destination: FakeDestination;

beforeAll(async () => {
  // random 0 gives the minimum backoff (1 s), so a retry happens within the test.
  t = await createTestApp({ clock: systemClock, random: () => 0 });
  destination = await FakeDestination.start();
  await t.runtime.startWorker();
});

afterAll(async () => {
  await t.close();
  await destination.close();
});

async function waitForDelivery(
  eventId: string,
  done: (delivery: Delivery) => boolean,
  timeoutMs = 15_000,
): Promise<Delivery> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = await t.runtime.database.repositories.deliveries.list({ eventId, limit: 1 });
    const delivery = page.items[0];
    if (delivery && done(delivery)) return delivery;
    if (Date.now() > deadline) throw new Error(`Delivery not done: ${JSON.stringify(delivery)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('end to end', () => {
  it('delivers a published event to the subscriber, retrying a failure', async () => {
    const secret = generateSecret();
    const subscription = aSubscription({
      id: newId(),
      target: destination.url,
      eventTypes: ['appointment.*'],
    });
    await t.runtime.database.repositories.subscriptions.insert(subscription);
    await t.runtime.database.repositories.subscriptions.addSecret(subscription.id, {
      id: newId(),
      value: secret,
      createdAt: NOW,
    });
    destination.respondWith({ status: 503 });

    const response = await t.app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: await t.bearer('source', 'scheduling-api') },
      payload: {
        id: 'outbox-e2e',
        type: 'appointment.created',
        occurredAt: new Date().toISOString(),
        data: { appointmentId: 'a-42' },
      },
    });
    expect(response.statusCode).toBe(202);
    const eventId = response.json<{ id: string }>().id;

    await destination.waitForRequests(2, 15_000);
    const delivery = await waitForDelivery(eventId, (d) => d.status === 'succeeded');

    expect(delivery.attempts).toBe(2);
    const history = await t.runtime.database.repositories.attempts.listByDelivery(delivery.id);
    expect(history.map((attempt) => attempt.httpStatus)).toEqual([503, 200]);

    const last = destination.requests.at(-1);
    const verification = verify({
      secrets: [secret],
      messageId: last?.headers['webhook-id'] as string,
      timestamp: last?.headers['webhook-timestamp'] as string,
      signature: last?.headers['webhook-signature'] as string,
      body: last?.body ?? '',
      now: new Date(),
    });
    expect(verification.ok).toBe(true);
  });
});
