import { describe, expect, it } from 'vitest';

import type { AttemptOutcome } from '../../../src/domain/attempt-outcome.js';
import { recordAttempt, replay, type Delivery } from '../../../src/domain/delivery.js';
import type { Result } from '../../../src/domain/result.js';
import { DEFAULT_RETRY_POLICY } from '../../../src/domain/retry-policy.js';
import { aDelivery, minutesAfter, NOW } from '../../support/builders.js';

const http = (status: number, retryAfterMs?: number): AttemptOutcome =>
  retryAfterMs === undefined
    ? { kind: 'response', status }
    : { kind: 'response', status, retryAfterMs };

const context = { now: NOW, random: () => 0.5 };

function unwrap(result: Result<Delivery>): Delivery {
  if (!result.ok) throw new Error(`Expected success, got ${result.error.code}`);
  return result.value;
}

describe('a new delivery', () => {
  it('starts pending, due immediately, with no attempts', () => {
    expect(aDelivery()).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
      lastError: null,
    });
  });
});

describe('recordAttempt', () => {
  it('succeeds on a 2xx (D3)', () => {
    const delivery = unwrap(recordAttempt(aDelivery(), http(204), context));

    expect(delivery).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: NOW,
    });
  });

  it('schedules a jittered retry on a retryable failure (D4)', () => {
    const delivery = unwrap(recordAttempt(aDelivery(), http(503), context));

    // First ceiling is 30 s; random 0.5 gives 15 s.
    expect(delivery).toMatchObject({ status: 'failed', attempts: 1, lastError: 'HTTP 503' });
    expect(delivery.nextAttemptAt).toEqual(new Date(NOW.getTime() + 15_000));
  });

  it('retries timeouts and network errors (D4)', () => {
    const timedOut = unwrap(
      recordAttempt(aDelivery(), { kind: 'timeout', timeoutMs: 10_000 }, context),
    );
    const refused = unwrap(
      recordAttempt(aDelivery(), { kind: 'network_error', message: 'ECONNREFUSED' }, context),
    );

    expect(timedOut.status).toBe('failed');
    expect(refused).toMatchObject({ status: 'failed', lastError: 'Network error: ECONNREFUSED' });
  });

  it('goes straight to dead on a permanent failure, without retrying (D5)', () => {
    const delivery = unwrap(recordAttempt(aDelivery(), http(400), context));

    expect(delivery).toMatchObject({
      status: 'dead',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'HTTP 400',
    });
  });

  it('respects Retry-After on 429 instead of its own backoff (D7)', () => {
    const delivery = unwrap(recordAttempt(aDelivery(), http(429, 90_000), context));

    expect(delivery.nextAttemptAt).toEqual(new Date(NOW.getTime() + 90_000));
  });

  it('caps an excessive Retry-After at the policy maximum', () => {
    const delivery = unwrap(recordAttempt(aDelivery(), http(429, 48 * 3_600_000), context));

    expect(delivery.nextAttemptAt).toEqual(
      new Date(NOW.getTime() + DEFAULT_RETRY_POLICY.maxDelayMs),
    );
  });

  it('dead-letters after 8 failed attempts (D6)', () => {
    let delivery = aDelivery();
    for (let attempt = 1; attempt <= 7; attempt++) {
      delivery = unwrap(recordAttempt(delivery, http(500), context));
      expect(delivery.status).toBe('failed');
    }

    delivery = unwrap(recordAttempt(delivery, http(500), context));

    expect(delivery).toMatchObject({
      status: 'dead',
      attempts: 8,
      nextAttemptAt: null,
      lastError: 'HTTP 500 (gave up after 8 attempts)',
    });
  });

  it('succeeds after earlier failures: 500, 500, 200 means three attempts', () => {
    let delivery = aDelivery();
    delivery = unwrap(recordAttempt(delivery, http(500), context));
    delivery = unwrap(
      recordAttempt(delivery, http(500), { ...context, now: minutesAfter(NOW, 1) }),
    );
    delivery = unwrap(
      recordAttempt(delivery, http(200), { ...context, now: minutesAfter(NOW, 3) }),
    );

    expect(delivery).toMatchObject({ status: 'succeeded', attempts: 3, lastError: null });
  });

  it.each(['succeeded', 'dead'] as const)('refuses to attempt a %s delivery', (status) => {
    const result = recordAttempt(aDelivery({ status }), http(200), context);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'Delivery.NotDeliverable', type: 'conflict' },
    });
  });
});

describe('replay (D6)', () => {
  it('puts a dead delivery back to pending with a fresh retry budget', () => {
    const dead = aDelivery({
      status: 'dead',
      attempts: 8,
      nextAttemptAt: null,
      lastError: 'HTTP 500',
    });
    const later = minutesAfter(NOW, 60);

    const delivery = unwrap(replay(dead, later));

    expect(delivery).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: later,
      lastError: null,
      updatedAt: later,
    });
  });

  it.each(['pending', 'failed', 'succeeded'] as const)(
    'refuses to replay a %s delivery',
    (status) => {
      const result = replay(aDelivery({ status }), NOW);

      expect(result).toMatchObject({ ok: false, error: { code: 'Delivery.NotDead' } });
    },
  );
});
