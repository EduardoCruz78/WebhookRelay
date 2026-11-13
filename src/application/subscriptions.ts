import type { Clock } from '../domain/clock.js';
import { err, ok, type DomainError, type Result } from '../domain/result.js';
import { generateSecret } from '../domain/signature.js';
import {
  validateTarget,
  type Channel,
  type Subscription,
  type TargetPolicy,
} from '../domain/subscription.js';
import type { HostChecker, UnitOfWork } from './ports.js';

/** How long the previous secret keeps signing after a rotation, so receivers can switch calmly. */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionDeps {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly targetPolicy: TargetPolicy;
  readonly checkHost: HostChecker;
}

export const SubscriptionErrors = {
  notFound: (): DomainError => ({
    code: 'Subscription.NotFound',
    message: 'Subscription not found.',
    type: 'not_found',
  }),
  targetNotPublic: (host: string): DomainError => ({
    code: 'Subscription.TargetNotPublic',
    message: `${host} resolves to a private or reserved address.`,
    type: 'business_rule',
  }),
  targetUnresolvable: (host: string): DomainError => ({
    code: 'Subscription.TargetUnresolvable',
    message: `${host} could not be resolved.`,
    type: 'business_rule',
  }),
  noSecret: (): DomainError => ({
    code: 'Subscription.NoSecret',
    message: 'Only webhook subscriptions have a signing secret.',
    type: 'business_rule',
  }),
} as const;

/** Validates the target for its channel; for webhooks, also resolves the host (SSRF, step 2). */
async function checkTarget(
  channel: Channel,
  target: string,
  deps: SubscriptionDeps,
): Promise<Result<string>> {
  const validated = validateTarget(channel, target, deps.targetPolicy);
  if (!validated.ok || channel !== 'webhook' || deps.targetPolicy.allowPrivateNetworks) {
    return validated;
  }
  const { hostname } = new URL(validated.value);
  const check = await deps.checkHost(hostname);
  if (check === 'not_public') return err(SubscriptionErrors.targetNotPublic(hostname));
  if (check === 'unresolvable') return err(SubscriptionErrors.targetUnresolvable(hostname));
  return validated;
}

export interface CreateSubscriptionCommand {
  readonly name: string;
  readonly channel: Channel;
  readonly target: string;
  readonly eventTypes: readonly string[];
}

/** Creates the subscription; a webhook also gets a signing secret, returned this one time only. */
export async function createSubscription(
  command: CreateSubscriptionCommand,
  deps: SubscriptionDeps,
): Promise<Result<{ subscription: Subscription; secret: string | null }>> {
  const target = await checkTarget(command.channel, command.target, deps);
  if (!target.ok) return target;

  const now = deps.clock.now();
  const subscription: Subscription = {
    id: deps.newId(),
    name: command.name.trim(),
    channel: command.channel,
    target: target.value,
    eventTypes: [...new Set(command.eventTypes)],
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  const secret = command.channel === 'webhook' ? generateSecret() : null;

  await deps.unitOfWork.run(async ({ repositories }) => {
    await repositories.subscriptions.insert(subscription);
    if (secret) {
      await repositories.subscriptions.addSecret(subscription.id, {
        id: deps.newId(),
        value: secret,
        createdAt: now,
      });
    }
  });
  return ok({ subscription, secret });
}

export interface UpdateSubscriptionCommand {
  readonly name?: string;
  readonly target?: string;
  readonly eventTypes?: readonly string[];
  readonly isActive?: boolean;
}

export async function updateSubscription(
  id: string,
  command: UpdateSubscriptionCommand,
  deps: SubscriptionDeps,
): Promise<Result<Subscription>> {
  return deps.unitOfWork.run(async ({ repositories }) => {
    const current = await repositories.subscriptions.findById(id);
    if (!current) return err(SubscriptionErrors.notFound());

    let target = current.target;
    if (command.target !== undefined) {
      const checked = await checkTarget(current.channel, command.target, deps);
      if (!checked.ok) return checked;
      target = checked.value;
    }

    const updated: Subscription = {
      ...current,
      name: command.name?.trim() ?? current.name,
      target,
      eventTypes: command.eventTypes ? [...new Set(command.eventTypes)] : current.eventTypes,
      isActive: command.isActive ?? current.isActive,
      updatedAt: deps.clock.now(),
    };
    await repositories.subscriptions.update(updated);
    return ok(updated);
  });
}

/**
 * Issues a new secret. The previous one keeps signing for 24 hours: during that window every
 * webhook carries two signatures, so the receiver can deploy the new secret without losing events.
 */
export async function rotateSecret(
  id: string,
  deps: SubscriptionDeps,
): Promise<Result<{ secret: string; previousSecretExpiresAt: Date }>> {
  return deps.unitOfWork.run(async ({ repositories }) => {
    const subscription = await repositories.subscriptions.findById(id);
    if (!subscription) return err(SubscriptionErrors.notFound());
    if (subscription.channel !== 'webhook') return err(SubscriptionErrors.noSecret());

    const now = deps.clock.now();
    const previousSecretExpiresAt = new Date(now.getTime() + ROTATION_GRACE_MS);
    const secret = generateSecret();
    await repositories.subscriptions.expireCurrentSecrets(id, previousSecretExpiresAt);
    await repositories.subscriptions.addSecret(id, {
      id: deps.newId(),
      value: secret,
      createdAt: now,
    });
    return ok({ secret, previousSecretExpiresAt });
  });
}
