import { beforeEach, describe, expect, it } from 'vitest';

import { ingestEvent, type IngestEventCommand } from '../../../src/application/ingest-event.js';
import { aSubscription, NOW } from '../../support/builders.js';
import { FakeClock, FakeStore, sequentialIds } from '../../support/fakes.js';

let store: FakeStore;
let deps: Parameters<typeof ingestEvent>[1];

const command = (overrides: Partial<IngestEventCommand> = {}): IngestEventCommand => ({
  source: 'scheduling-api',
  externalId: 'outbox-1',
  type: 'appointment.created',
  occurredAt: new Date('2026-12-07T11:59:00Z'),
  data: { appointmentId: 'a-1' },
  ...overrides,
});

beforeEach(() => {
  store = new FakeStore();
  deps = { unitOfWork: store.unitOfWork, clock: new FakeClock(NOW), newId: sequentialIds() };
});

async function givenSubscriptions(...subscriptions: Parameters<typeof aSubscription>[0][]) {
  for (const [index, overrides] of subscriptions.entries()) {
    await store.repositories.subscriptions.insert(
      aSubscription({ id: `sub-${index + 1}`, ...overrides }),
    );
  }
}

describe('ingestEvent', () => {
  it('stores the event with the source, idempotency key and receive time', async () => {
    const result = await ingestEvent(command(), deps);

    expect(result.status).toBe('created');
    expect(result.event).toEqual({
      id: 'id-1',
      source: 'scheduling-api',
      type: 'appointment.created',
      payload: { appointmentId: 'a-1' },
      occurredAt: new Date('2026-12-07T11:59:00Z'),
      receivedAt: NOW,
      idempotencyKey: 'outbox-1',
    });
  });

  it('fans out to every active subscription interested in the type (D2)', async () => {
    await givenSubscriptions(
      { eventTypes: ['appointment.created'] },
      { eventTypes: ['appointment.*'] },
      { eventTypes: ['appointment.cancelled'] },
      { eventTypes: ['*'], isActive: false },
    );

    const result = await ingestEvent(command(), deps);

    expect(result).toMatchObject({ status: 'created', deliveryCount: 2 });
    const deliveries = [...store.state.deliveries.values()];
    expect(deliveries.map((d) => d.subscriptionId).sort()).toEqual(['sub-1', 'sub-2']);
    expect(deliveries.every((d) => d.status === 'pending' && d.eventId === 'id-1')).toBe(true);
  });

  it('enqueues one job per delivery, due immediately', async () => {
    await givenSubscriptions({ eventTypes: ['*'] }, { eventTypes: ['*'] });

    await ingestEvent(command(), deps);

    const deliveryIds = [...store.state.deliveries.keys()].sort();
    expect(store.state.jobs.map((job) => job.deliveryId).sort()).toEqual(deliveryIds);
    expect(store.state.jobs.every((job) => job.runAt.getTime() === NOW.getTime())).toBe(true);
  });

  it('accepts an event nobody subscribes to, with zero deliveries', async () => {
    const result = await ingestEvent(command(), deps);

    expect(result).toMatchObject({ status: 'created', deliveryCount: 0 });
    expect(store.state.jobs).toEqual([]);
  });

  it('ignores a repeated event: no new event, deliveries or jobs (D1)', async () => {
    await givenSubscriptions({ eventTypes: ['*'] });
    const first = await ingestEvent(command(), deps);

    const second = await ingestEvent(command({ data: { changed: true } }), deps);

    expect(second).toEqual({ status: 'duplicate', event: first.event });
    expect(store.state.events.size).toBe(1);
    expect(store.state.deliveries.size).toBe(1);
    expect(store.state.jobs).toHaveLength(1);
  });

  it('treats the same external id from another source as a new event', async () => {
    await ingestEvent(command(), deps);

    const other = await ingestEvent(command({ source: 'billing' }), deps);

    expect(other.status).toBe('created');
  });

  it('records nothing when enqueuing fails (all or nothing)', async () => {
    await givenSubscriptions({ eventTypes: ['*'] });
    const failingQueue = {
      run: <T>(work: Parameters<typeof store.unitOfWork.run<T>>[0]) =>
        store.unitOfWork.run((tx) =>
          work({
            ...tx,
            queue: { enqueue: () => Promise.reject(new Error('queue unavailable')) },
          }),
        ),
    };

    await expect(ingestEvent(command(), { ...deps, unitOfWork: failingQueue })).rejects.toThrow(
      'queue unavailable',
    );

    expect(store.state.events.size).toBe(0);
    expect(store.state.deliveries.size).toBe(0);
  });
});
