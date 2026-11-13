import { describeOutcome } from '../domain/attempt-outcome.js';
import type { Clock, RandomSource } from '../domain/clock.js';
import { abandon, isFinal, recordAttempt, type Delivery } from '../domain/delivery.js';
import type { DeliveryAttempt } from '../domain/delivery-attempt.js';
import type { Result } from '../domain/result.js';
import type { RetryPolicy } from '../domain/retry-policy.js';
import { activeSecrets } from '../domain/signature.js';
import type { ChannelResult, Channels, Repositories, UnitOfWork } from './ports.js';

export interface DeliverDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly channels: Channels;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly newId: () => string;
  readonly policy?: RetryPolicy;
}

export type DeliverOutcome =
  /** Nothing to do: unknown, already final, not due yet, or another worker recorded it first. */
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'attempted'; readonly delivery: Delivery; readonly result: ChannelResult }
  | { readonly kind: 'abandoned'; readonly delivery: Delivery };

/** A job that arrives a little early (clock skew between hosts) still counts as due. */
const EARLY_TOLERANCE_MS = 5_000;

/**
 * One attempt of one delivery, run by the worker for each queued job:
 * load → send through the subscription's channel → apply the domain rules (D3 to D7) →
 * in one transaction, save the attempt and the new state, and enqueue the retry if one is due.
 *
 * The network call happens outside any transaction: a slow destination must not hold a database
 * connection (or row locks) for up to 10 seconds.
 */
export async function deliver(deliveryId: string, deps: DeliverDeps): Promise<DeliverOutcome> {
  const { repositories } = deps;
  const delivery = await repositories.deliveries.findById(deliveryId);
  if (!delivery) return { kind: 'skipped', reason: 'unknown delivery' };
  if (isFinal(delivery.status)) return { kind: 'skipped', reason: `already ${delivery.status}` };

  const now = deps.clock.now();
  if (
    delivery.nextAttemptAt &&
    delivery.nextAttemptAt.getTime() - now.getTime() > EARLY_TOLERANCE_MS
  ) {
    // A stale job (e.g. a crashed worker's job re-run by pg-boss after the retry was rescheduled).
    return { kind: 'skipped', reason: 'not due yet' };
  }

  const [event, subscription] = await Promise.all([
    repositories.events.findById(delivery.eventId),
    repositories.subscriptions.findById(delivery.subscriptionId),
  ]);
  const channel = subscription && deps.channels[subscription.channel];

  if (!event || !subscription?.isActive || !channel) {
    const reason = !event
      ? 'Event no longer exists'
      : !subscription?.isActive
        ? 'Subscription is inactive or was deleted'
        : `Channel '${subscription.channel}' is not configured`;
    return saveAbandoned(delivery, abandon(delivery, reason, now), deps);
  }

  const secrets = activeSecrets(
    await repositories.subscriptions.activeSecrets(subscription.id, now),
    now,
  );
  const result = await channel.send({ event, subscription, secrets, now });

  const next = recordAttempt(delivery, result.outcome, {
    now,
    random: deps.random,
    ...(deps.policy && { policy: deps.policy }),
  });
  if (!next.ok) return { kind: 'skipped', reason: next.error.message };

  const attempt: DeliveryAttempt = {
    id: deps.newId(),
    deliveryId: delivery.id,
    attemptNumber: next.value.attempts,
    startedAt: now,
    durationMs: result.durationMs,
    httpStatus: result.outcome.kind === 'response' ? result.outcome.status : null,
    error: next.value.status === 'succeeded' ? null : describeOutcome(result.outcome),
    responseSnippet: result.responseSnippet,
  };

  const saved = await deps.unitOfWork.run(async (tx) => {
    const updated = await tx.repositories.deliveries.update(next.value, {
      status: delivery.status,
      attempts: delivery.attempts,
    });
    if (!updated) return false;
    await tx.repositories.attempts.insert(attempt);
    if (next.value.status === 'failed' && next.value.nextAttemptAt) {
      await tx.queue.enqueue([{ deliveryId: delivery.id, runAt: next.value.nextAttemptAt }]);
    }
    return true;
  });

  if (!saved) return { kind: 'skipped', reason: 'recorded concurrently by another worker' };
  return { kind: 'attempted', delivery: next.value, result };
}

async function saveAbandoned(
  delivery: Delivery,
  next: Result<Delivery>,
  deps: DeliverDeps,
): Promise<DeliverOutcome> {
  if (!next.ok) return { kind: 'skipped', reason: next.error.message };
  const saved = await deps.repositories.deliveries.update(next.value, {
    status: delivery.status,
    attempts: delivery.attempts,
  });
  if (!saved) return { kind: 'skipped', reason: 'recorded concurrently by another worker' };
  return { kind: 'abandoned', delivery: next.value };
}
