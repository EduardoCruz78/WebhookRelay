import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../../src/application/ids.js';
import type { Repositories } from '../../../src/application/ports.js';
import type { Delivery } from '../../../src/domain/delivery.js';
import type { DeliveryAttempt } from '../../../src/domain/delivery-attempt.js';
import type { Subscription } from '../../../src/domain/subscription.js';
import { InvalidCursorError } from '../../../src/application/ports.js';
import { aDelivery, anEvent, aSubscription, minutesAfter, NOW } from '../../support/builders.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';

let testDb: TestDatabase;
let repos: Repositories;

beforeAll(async () => {
  testDb = await createTestDatabase();
  repos = testDb.database.repositories;
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
});

async function givenSubscription(overrides: Partial<Subscription> = {}): Promise<Subscription> {
  const subscription = aSubscription({ id: newId(), ...overrides });
  await repos.subscriptions.insert(subscription);
  return subscription;
}

async function givenEvent(idempotencyKey = newId()) {
  const { event } = await repos.events.insertIfAbsent(anEvent({ id: newId(), idempotencyKey }));
  return event;
}

function deliveryFor(eventId: string, subscriptionId: string, overrides: Partial<Delivery> = {}) {
  return aDelivery({ id: newId(), eventId, subscriptionId, ...overrides });
}

describe('EventRepository', () => {
  it('inserts a new event and reads it back with the JSON payload intact', async () => {
    const event = anEvent({
      id: newId(),
      payload: { nested: { list: [1, 'two', null, true] }, text: 'café' },
    });

    const result = await repos.events.insertIfAbsent(event);

    expect(result).toEqual({ inserted: true, event });
    expect(await repos.events.findById(event.id)).toEqual(event);
  });

  it('returns the original event for a repeated source + idempotency key (D1)', async () => {
    const original = anEvent({ id: newId(), idempotencyKey: 'outbox-42' });
    await repos.events.insertIfAbsent(original);

    const repeated = await repos.events.insertIfAbsent(
      anEvent({ id: newId(), idempotencyKey: 'outbox-42', payload: { different: true } }),
    );

    expect(repeated).toEqual({ inserted: false, event: original });
  });

  it('treats the same idempotency key from another source as a different event', async () => {
    await repos.events.insertIfAbsent(anEvent({ id: newId(), idempotencyKey: 'k' }));

    const other = await repos.events.insertIfAbsent(
      anEvent({ id: newId(), idempotencyKey: 'k', source: 'billing' }),
    );

    expect(other.inserted).toBe(true);
  });

  it('lets exactly one of many concurrent duplicates win', async () => {
    const attempts = Array.from({ length: 10 }, () =>
      repos.events.insertIfAbsent(anEvent({ id: newId(), idempotencyKey: 'race' })),
    );

    const results = await Promise.all(attempts);

    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    expect(new Set(results.map((result) => result.event.id)).size).toBe(1);
  });

  it('returns undefined for an unknown id', async () => {
    expect(await repos.events.findById(newId())).toBeUndefined();
  });
});

describe('SubscriptionRepository', () => {
  it('round-trips a subscription', async () => {
    const subscription = await givenSubscription({ eventTypes: ['appointment.*', 'user.created'] });

    expect(await repos.subscriptions.findById(subscription.id)).toEqual(subscription);
  });

  it('updates mutable fields', async () => {
    const subscription = await givenSubscription();
    const changed = {
      ...subscription,
      isActive: false,
      eventTypes: ['*'],
      updatedAt: minutesAfter(NOW, 5),
    };

    await repos.subscriptions.update(changed);

    expect(await repos.subscriptions.findById(subscription.id)).toEqual(changed);
  });

  it('finds only active subscriptions whose filter matches the event type (D2)', async () => {
    const exact = await givenSubscription({ name: 'exact', eventTypes: ['appointment.created'] });
    const prefix = await givenSubscription({ name: 'prefix', eventTypes: ['appointment.*'] });
    const all = await givenSubscription({ name: 'all', eventTypes: ['*'] });
    await givenSubscription({ name: 'other type', eventTypes: ['appointment.cancelled'] });
    await givenSubscription({ name: 'other prefix', eventTypes: ['user.*'] });
    await givenSubscription({ name: 'inactive', eventTypes: ['*'], isActive: false });

    const found = await repos.subscriptions.findInterestedIn('appointment.created');

    expect(found.map((s) => s.name).sort()).toEqual([all.name, exact.name, prefix.name].sort());
  });

  it('can answer the fan-out query from the partial GIN index', async () => {
    await givenSubscription({ eventTypes: ['appointment.*'] });

    // Tiny tables are always scanned sequentially; disabling that shows the index is usable.
    const plan = await testDb.database.transaction(async ({ executeSql }) => {
      await executeSql('SET LOCAL enable_seqscan = off');
      const { rows } = await executeSql(
        `EXPLAIN SELECT * FROM subscriptions
          WHERE is_active AND event_types && ARRAY['*', 'appointment.created', 'appointment.*']`,
      );
      return rows.map((row) => Object.values(row as Record<string, string>).join('')).join('\n');
    });

    expect(plan).toContain('subscriptions_active_event_types_idx');
  });

  it('rejects an empty event type list at the database level', async () => {
    await expect(givenSubscription({ eventTypes: [] })).rejects.toThrow();
  });

  describe('secrets', () => {
    it('returns current and not-yet-expired secrets, newest first', async () => {
      const subscription = await givenSubscription();
      await repos.subscriptions.addSecret(subscription.id, {
        id: newId(),
        value: 'whsec_old',
        createdAt: NOW,
      });
      await repos.subscriptions.expireCurrentSecrets(subscription.id, minutesAfter(NOW, 24 * 60));
      await repos.subscriptions.addSecret(subscription.id, {
        id: newId(),
        value: 'whsec_new',
        createdAt: minutesAfter(NOW, 1),
      });

      expect(
        await repos.subscriptions.activeSecrets(subscription.id, minutesAfter(NOW, 2)),
      ).toEqual([
        { value: 'whsec_new', expiresAt: null },
        { value: 'whsec_old', expiresAt: minutesAfter(NOW, 24 * 60) },
      ]);
      expect(
        await repos.subscriptions.activeSecrets(subscription.id, minutesAfter(NOW, 24 * 60)),
      ).toEqual([{ value: 'whsec_new', expiresAt: null }]);
    });

    it('does not move the expiry of a secret that is already expiring', async () => {
      const subscription = await givenSubscription();
      await repos.subscriptions.addSecret(subscription.id, {
        id: newId(),
        value: 'a',
        createdAt: NOW,
      });
      await repos.subscriptions.expireCurrentSecrets(subscription.id, minutesAfter(NOW, 10));
      await repos.subscriptions.addSecret(subscription.id, {
        id: newId(),
        value: 'b',
        createdAt: minutesAfter(NOW, 1),
      });

      await repos.subscriptions.expireCurrentSecrets(subscription.id, minutesAfter(NOW, 60));

      const secrets = await repos.subscriptions.activeSecrets(subscription.id, NOW);
      expect(secrets).toEqual([
        { value: 'b', expiresAt: minutesAfter(NOW, 60) },
        { value: 'a', expiresAt: minutesAfter(NOW, 10) },
      ]);
    });
  });
});

describe('DeliveryRepository', () => {
  it('inserts deliveries and skips (event, subscription) pairs that already exist (D2)', async () => {
    const event = await givenEvent();
    const first = await givenSubscription();
    const second = await givenSubscription();
    await repos.deliveries.insertMany([deliveryFor(event.id, first.id)]);

    const inserted = await repos.deliveries.insertMany([
      deliveryFor(event.id, first.id),
      deliveryFor(event.id, second.id),
    ]);

    expect(inserted.map((d) => d.subscriptionId)).toEqual([second.id]);
    const page = await repos.deliveries.list({ eventId: event.id, limit: 10 });
    expect(page.items).toHaveLength(2);
  });

  it('does nothing for an empty list', async () => {
    expect(await repos.deliveries.insertMany([])).toEqual([]);
  });

  it('persists state transitions', async () => {
    const event = await givenEvent();
    const subscription = await givenSubscription();
    const [delivery] = await repos.deliveries.insertMany([deliveryFor(event.id, subscription.id)]);
    if (!delivery) throw new Error('not inserted');
    const failed: Delivery = {
      ...delivery,
      status: 'failed',
      attempts: 1,
      nextAttemptAt: minutesAfter(NOW, 1),
      lastError: 'HTTP 503',
      updatedAt: minutesAfter(NOW, 0.5),
    };

    const saved = await repos.deliveries.update(failed, { status: 'pending', attempts: 0 });

    expect(saved).toBe(true);
    expect(await repos.deliveries.findById(delivery.id)).toEqual(failed);
  });

  it('refuses a stale update (optimistic concurrency)', async () => {
    const event = await givenEvent();
    const subscription = await givenSubscription();
    const [delivery] = await repos.deliveries.insertMany([deliveryFor(event.id, subscription.id)]);
    if (!delivery) throw new Error('not inserted');
    const first = { ...delivery, status: 'failed' as const, attempts: 1 };
    const second = { ...delivery, status: 'succeeded' as const, attempts: 1 };

    // Two workers both read the pending delivery; only the first save wins.
    expect(await repos.deliveries.update(first, { status: 'pending', attempts: 0 })).toBe(true);
    expect(await repos.deliveries.update(second, { status: 'pending', attempts: 0 })).toBe(false);
    expect((await repos.deliveries.findById(delivery.id))?.status).toBe('failed');
  });

  it('rejects an unknown status at the database level', async () => {
    const event = await givenEvent();
    const subscription = await givenSubscription();

    await expect(
      repos.deliveries.insertMany([
        deliveryFor(event.id, subscription.id, { status: 'lost' as Delivery['status'] }),
      ]),
    ).rejects.toThrow();
  });

  it('rejects a delivery for an event that does not exist', async () => {
    const subscription = await givenSubscription();

    await expect(
      repos.deliveries.insertMany([deliveryFor(newId(), subscription.id)]),
    ).rejects.toThrow();
  });

  describe('list', () => {
    async function givenDeliveries(count: number, overrides: Partial<Delivery> = {}) {
      const subscription = await givenSubscription();
      const created: Delivery[] = [];
      for (let i = 0; i < count; i++) {
        const event = await givenEvent();
        const delivery = deliveryFor(event.id, subscription.id, {
          createdAt: minutesAfter(NOW, i),
          ...overrides,
        });
        created.push(delivery);
      }
      await repos.deliveries.insertMany(created);
      return { subscription, created };
    }

    it('filters by status and subscription, newest first', async () => {
      const { subscription, created } = await givenDeliveries(3, { status: 'dead' });
      await givenDeliveries(2, { status: 'dead' });
      await givenDeliveries(2, { status: 'succeeded' });

      const page = await repos.deliveries.list({
        status: 'dead',
        subscriptionId: subscription.id,
        limit: 10,
      });

      expect(page.items.map((d) => d.id)).toEqual(created.map((d) => d.id).reverse());
      expect(page.nextCursor).toBeNull();
    });

    it('pages through results with a keyset cursor, without gaps or repeats', async () => {
      const { created } = await givenDeliveries(5);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await repos.deliveries.list({ limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((d) => d.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual(created.map((d) => d.id).reverse());
    });

    it('breaks ties on identical timestamps by id', async () => {
      const { created } = await givenDeliveries(4, { createdAt: NOW });

      const first = await repos.deliveries.list({ limit: 2 });
      const second = await repos.deliveries.list({ limit: 2, cursor: first.nextCursor ?? '' });

      const ids = [...first.items, ...second.items].map((d) => d.id);
      expect(new Set(ids).size).toBe(4);
      expect(ids.sort()).toEqual(created.map((d) => d.id).sort());
    });

    it('rejects a malformed cursor', async () => {
      await expect(repos.deliveries.list({ limit: 2, cursor: 'garbage' })).rejects.toThrow(
        InvalidCursorError,
      );
    });
  });
});

describe('DeliveryAttemptRepository', () => {
  async function givenDelivery() {
    const event = await givenEvent();
    const subscription = await givenSubscription();
    const [delivery] = await repos.deliveries.insertMany([deliveryFor(event.id, subscription.id)]);
    if (!delivery) throw new Error('not inserted');
    return delivery;
  }

  const anAttempt = (deliveryId: string, attemptNumber: number): DeliveryAttempt => ({
    id: newId(),
    deliveryId,
    attemptNumber,
    startedAt: minutesAfter(NOW, attemptNumber),
    durationMs: 120,
    httpStatus: attemptNumber < 3 ? 500 : 200,
    error: attemptNumber < 3 ? 'HTTP 500' : null,
    responseSnippet: attemptNumber < 3 ? '{"error":"boom"}' : null,
  });

  it('keeps the attempt history in order', async () => {
    const delivery = await givenDelivery();
    const attempts = [
      anAttempt(delivery.id, 2),
      anAttempt(delivery.id, 1),
      anAttempt(delivery.id, 3),
    ];
    for (const attempt of attempts) await repos.attempts.insert(attempt);

    const history = await repos.attempts.listByDelivery(delivery.id);

    expect(history.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    expect(history[0]).toEqual(attempts[1]);
  });
});

describe('Database.transaction', () => {
  it('commits everything done through the scope', async () => {
    const event = anEvent({ id: newId() });

    await testDb.database.transaction(({ repositories }) =>
      repositories.events.insertIfAbsent(event),
    );

    expect(await repos.events.findById(event.id)).toEqual(event);
  });

  it('rolls back repositories and raw SQL together when the work fails', async () => {
    const event = anEvent({ id: newId() });

    await expect(
      testDb.database.transaction(async ({ repositories, executeSql }) => {
        await repositories.events.insertIfAbsent(event);
        // Visible inside the transaction through the raw connection too.
        const { rows } = await executeSql('SELECT id FROM events WHERE id = $1', [event.id]);
        expect(rows).toHaveLength(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await repos.events.findById(event.id)).toBeUndefined();
  });

  it('returns connections to the pool, even after failures', async () => {
    for (let i = 0; i < 20; i++) {
      await testDb.database
        .transaction(() => Promise.reject(new Error('fail')))
        .catch(() => undefined);
    }

    expect(testDb.database.pool.totalCount).toBeLessThanOrEqual(5);
    expect(testDb.database.pool.idleCount).toBe(testDb.database.pool.totalCount);
  });
});
