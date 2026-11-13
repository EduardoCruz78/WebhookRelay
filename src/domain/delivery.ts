import type { RandomSource } from './clock.js';
import { classifyOutcome, describeOutcome, type AttemptOutcome } from './attempt-outcome.js';
import { err, ok, type DomainError, type Result } from './result.js';
import { DEFAULT_RETRY_POLICY, nextDelayMs, type RetryPolicy } from './retry-policy.js';

/**
 * pending   → waiting for its first attempt (or re-queued by a replay)
 * failed    → last attempt failed temporarily; a retry is scheduled at `nextAttemptAt`
 * succeeded → destination answered 2xx (final)
 * dead      → permanent failure or retries exhausted: the dead-letter state (final until replayed)
 */
export type DeliveryStatus = 'pending' | 'failed' | 'succeeded' | 'dead';

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'pending',
  'failed',
  'succeeded',
  'dead',
];

/** One event for one subscription. Unique per (eventId, subscriptionId), so fan-out never duplicates. */
export interface Delivery {
  readonly id: string;
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly status: DeliveryStatus;
  /** Attempts in the current cycle (a replay starts a new cycle with a fresh retry budget). */
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function createDelivery(params: {
  id: string;
  eventId: string;
  subscriptionId: string;
  now: Date;
}): Delivery {
  return {
    id: params.id,
    eventId: params.eventId,
    subscriptionId: params.subscriptionId,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: params.now,
    lastError: null,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function isFinal(status: DeliveryStatus): boolean {
  return status === 'succeeded' || status === 'dead';
}

export const DeliveryErrors = {
  notDeliverable: (status: DeliveryStatus): DomainError => ({
    code: 'Delivery.NotDeliverable',
    message: `A delivery in status '${status}' cannot be attempted.`,
    type: 'conflict',
  }),
  notDead: (status: DeliveryStatus): DomainError => ({
    code: 'Delivery.NotDead',
    message: `Only dead deliveries can be replayed; this one is '${status}'.`,
    type: 'conflict',
  }),
} as const;

export interface AttemptContext {
  readonly now: Date;
  readonly random: RandomSource;
  readonly policy?: RetryPolicy;
}

/** Applies the outcome of one attempt (rules D3 to D7) and returns the delivery's next state. */
export function recordAttempt(
  delivery: Delivery,
  outcome: AttemptOutcome,
  context: AttemptContext,
): Result<Delivery> {
  if (isFinal(delivery.status)) return err(DeliveryErrors.notDeliverable(delivery.status));

  const policy = context.policy ?? DEFAULT_RETRY_POLICY;
  const attempts = delivery.attempts + 1;
  const base = { ...delivery, attempts, updatedAt: context.now };

  switch (classifyOutcome(outcome)) {
    case 'success':
      return ok({ ...base, status: 'succeeded', nextAttemptAt: null, lastError: null });

    case 'permanent':
      return ok({
        ...base,
        status: 'dead',
        nextAttemptAt: null,
        lastError: describeOutcome(outcome),
      });

    case 'retryable': {
      if (attempts >= policy.maxAttempts) {
        return ok({
          ...base,
          status: 'dead',
          nextAttemptAt: null,
          lastError: `${describeOutcome(outcome)} (gave up after ${attempts} attempts)`,
        });
      }
      const delay = retryDelayMs(outcome, attempts, context.random, policy);
      return ok({
        ...base,
        status: 'failed',
        nextAttemptAt: new Date(context.now.getTime() + delay),
        lastError: describeOutcome(outcome),
      });
    }
  }
}

/** D7: a destination's `Retry-After` wins over our own backoff, capped by the policy maximum. */
function retryDelayMs(
  outcome: AttemptOutcome,
  attempts: number,
  random: RandomSource,
  policy: RetryPolicy,
): number {
  if (outcome.kind === 'response' && outcome.retryAfterMs !== undefined) {
    return Math.min(policy.maxDelayMs, Math.max(policy.minDelayMs, outcome.retryAfterMs));
  }
  return nextDelayMs(attempts, random, policy);
}

/** D6: a dead delivery can be sent again manually, with a fresh retry budget. */
export function replay(delivery: Delivery, now: Date): Result<Delivery> {
  if (delivery.status !== 'dead') return err(DeliveryErrors.notDead(delivery.status));
  return ok({
    ...delivery,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastError: null,
    updatedAt: now,
  });
}
