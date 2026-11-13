import { beforeEach, describe, expect, it } from 'vitest';

import { replayDelivery } from '../../../src/application/replay-delivery.js';
import {
  createSubscription,
  rotateSecret,
  updateSubscription,
  type SubscriptionDeps,
} from '../../../src/application/subscriptions.js';
import { isValidSecret } from '../../../src/domain/signature.js';
import { aDelivery, minutesAfter, NOW } from '../../support/builders.js';
import { FakeClock, FakeStore, sequentialIds } from '../../support/fakes.js';

let store: FakeStore;
let clock: FakeClock;
let deps: SubscriptionDeps;
const checkedHosts: string[] = [];

beforeEach(() => {
  store = new FakeStore();
  clock = new FakeClock(NOW);
  checkedHosts.length = 0;
  deps = {
    unitOfWork: store.unitOfWork,
    clock,
    newId: sequentialIds(),
    targetPolicy: { allowPrivateNetworks: false, allowHttp: false },
    checkHost: async (host) => {
      checkedHosts.push(host);
      if (host === 'rebind.example.com') return 'not_public';
      if (host === 'nowhere.example.com') return 'unresolvable';
      return 'public';
    },
  };
});

const webhook = (target = 'https://partner.example.com/hooks') => ({
  name: 'Partner',
  channel: 'webhook' as const,
  target,
  eventTypes: ['appointment.*', 'appointment.*'],
});

describe('createSubscription', () => {
  it('creates an active webhook subscription and returns its secret once', async () => {
    const result = await createSubscription(webhook(), deps);

    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.subscription).toMatchObject({
      name: 'Partner',
      isActive: true,
      eventTypes: ['appointment.*'],
      createdAt: NOW,
    });
    expect(isValidSecret(result.value.secret ?? '')).toBe(true);
    const stored = await store.repositories.subscriptions.activeSecrets(
      result.value.subscription.id,
      NOW,
    );
    expect(stored.map((s) => s.value)).toEqual([result.value.secret]);
  });

  it('resolves the webhook host before saving (SSRF)', async () => {
    await createSubscription(webhook(), deps);

    expect(checkedHosts).toEqual(['partner.example.com']);
  });

  it('refuses a host that resolves to a private address', async () => {
    const result = await createSubscription(webhook('https://rebind.example.com/x'), deps);

    expect(result).toMatchObject({ ok: false, error: { code: 'Subscription.TargetNotPublic' } });
    expect(store.state.subscriptions.size).toBe(0);
  });

  it('refuses a host that does not resolve', async () => {
    const result = await createSubscription(webhook('https://nowhere.example.com/x'), deps);

    expect(result).toMatchObject({ ok: false, error: { code: 'Subscription.TargetUnresolvable' } });
  });

  it('skips the DNS check when private networks are allowed (development)', async () => {
    const dev = { ...deps, targetPolicy: { allowPrivateNetworks: true, allowHttp: true } };

    const result = await createSubscription(webhook('http://localhost:4000/hook'), dev);

    expect(result.ok).toBe(true);
    expect(checkedHosts).toEqual([]);
  });

  it('creates e-mail subscriptions without a secret', async () => {
    const result = await createSubscription(
      { name: 'Ops', channel: 'email', target: 'ops@example.com', eventTypes: ['*'] },
      deps,
    );

    expect(result).toMatchObject({ ok: true, value: { secret: null } });
    expect(store.state.secrets).toEqual([]);
  });
});

describe('updateSubscription', () => {
  async function given() {
    const result = await createSubscription(webhook(), deps);
    if (!result.ok) throw new Error(result.error.code);
    return result.value.subscription;
  }

  it('deactivates and changes event types, stamping updatedAt', async () => {
    const subscription = await given();
    clock.advanceMinutes(5);

    const result = await updateSubscription(
      subscription.id,
      { isActive: false, eventTypes: ['*'] },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      value: { isActive: false, eventTypes: ['*'], updatedAt: minutesAfter(NOW, 5) },
    });
  });

  it('re-checks a new target', async () => {
    const subscription = await given();

    const result = await updateSubscription(
      subscription.id,
      { target: 'https://rebind.example.com/x' },
      deps,
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'Subscription.TargetNotPublic' } });
  });

  it('returns NotFound for an unknown id', async () => {
    expect(await updateSubscription('missing', { isActive: false }, deps)).toMatchObject({
      ok: false,
      error: { code: 'Subscription.NotFound', type: 'not_found' },
    });
  });
});

describe('rotateSecret', () => {
  it('issues a new secret and keeps the previous one valid for 24 hours', async () => {
    const created = await createSubscription(webhook(), deps);
    if (!created.ok) throw new Error(created.error.code);
    const { subscription, secret: oldSecret } = created.value;
    clock.advanceMinutes(10);

    const rotated = await rotateSecret(subscription.id, deps);

    if (!rotated.ok) throw new Error(rotated.error.code);
    expect(rotated.value.previousSecretExpiresAt).toEqual(minutesAfter(NOW, 10 + 24 * 60));
    const during = await store.repositories.subscriptions.activeSecrets(
      subscription.id,
      clock.now(),
    );
    expect(during.map((s) => s.value)).toEqual([rotated.value.secret, oldSecret]);
    const after = await store.repositories.subscriptions.activeSecrets(
      subscription.id,
      minutesAfter(NOW, 10 + 24 * 60),
    );
    expect(after.map((s) => s.value)).toEqual([rotated.value.secret]);
  });

  it('refuses channels without a secret', async () => {
    const created = await createSubscription(
      { name: 'Ops', channel: 'email', target: 'ops@example.com', eventTypes: ['*'] },
      deps,
    );
    if (!created.ok) throw new Error(created.error.code);

    expect(await rotateSecret(created.value.subscription.id, deps)).toMatchObject({
      ok: false,
      error: { code: 'Subscription.NoSecret' },
    });
  });
});

describe('replayDelivery', () => {
  it('puts a dead delivery back in the queue, due now', async () => {
    await store.repositories.deliveries.insertMany([
      aDelivery({ id: 'd-1', status: 'dead', attempts: 8, nextAttemptAt: null }),
    ]);
    clock.advanceMinutes(30);

    const result = await replayDelivery('d-1', { unitOfWork: store.unitOfWork, clock });

    expect(result).toMatchObject({ ok: true, value: { status: 'pending', attempts: 0 } });
    expect(store.state.jobs).toEqual([{ deliveryId: 'd-1', runAt: minutesAfter(NOW, 30) }]);
  });

  it('refuses a delivery that is not dead (409) and enqueues nothing', async () => {
    await store.repositories.deliveries.insertMany([aDelivery({ id: 'd-1', status: 'failed' })]);

    const result = await replayDelivery('d-1', { unitOfWork: store.unitOfWork, clock });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'Delivery.NotDead', type: 'conflict' },
    });
    expect(store.state.jobs).toEqual([]);
  });

  it('returns NotFound for an unknown delivery', async () => {
    expect(await replayDelivery('nope', { unitOfWork: store.unitOfWork, clock })).toMatchObject({
      ok: false,
      error: { code: 'Delivery.NotFound' },
    });
  });
});
