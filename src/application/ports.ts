import type { ApiKey } from '../domain/api-key.js';
import type { Delivery, DeliveryStatus } from '../domain/delivery.js';
import type { DeliveryAttempt } from '../domain/delivery-attempt.js';
import type { AttemptOutcome } from '../domain/attempt-outcome.js';
import type { Event } from '../domain/event.js';
import type { SigningSecret } from '../domain/signature.js';
import type { Channel, Subscription } from '../domain/subscription.js';

/**
 * Ports: what the use cases need from persistence, without knowing it is PostgreSQL + Drizzle.
 * Implemented in src/infrastructure/db; replaced by in-memory fakes in unit tests.
 */

export interface EventRepository {
  /**
   * Inserts the event unless one with the same source + idempotency key exists (rule D1).
   * Race-safe: two concurrent calls with the same key never both report `inserted: true`.
   */
  insertIfAbsent(event: Event): Promise<{ inserted: boolean; event: Event }>;
  findById(id: string): Promise<Event | undefined>;
}

export interface SubscriptionRepository {
  insert(subscription: Subscription): Promise<void>;
  update(subscription: Subscription): Promise<void>;
  findById(id: string): Promise<Subscription | undefined>;
  list(): Promise<Subscription[]>;
  /** Active subscriptions whose filter matches the event type (rule D2). */
  findInterestedIn(eventType: string): Promise<Subscription[]>;

  addSecret(
    subscriptionId: string,
    secret: { id: string; value: string; createdAt: Date },
  ): Promise<void>;
  /** Gives every currently non-expiring secret an expiry (used by rotation). */
  expireCurrentSecrets(subscriptionId: string, expiresAt: Date): Promise<void>;
  /** Secrets valid at `now`, newest first. */
  activeSecrets(subscriptionId: string, now: Date): Promise<SigningSecret[]>;
}

export interface DeliveryListFilter {
  readonly status?: DeliveryStatus;
  readonly subscriptionId?: string;
  readonly eventId?: string;
  readonly limit: number;
  /** Opaque keyset cursor returned by the previous page. */
  readonly cursor?: string;
}

/** Thrown by DeliveryRepository.list for a cursor it did not issue. */
export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface DeliveryRepository {
  /** Inserts deliveries, skipping any (event, subscription) pair that already exists. Returns the inserted ones. */
  insertMany(deliveries: readonly Delivery[]): Promise<Delivery[]>;
  /**
   * Saves a new state only if the stored one still has the expected status and attempt count
   * (optimistic concurrency). Returns false when another worker got there first.
   */
  update(
    delivery: Delivery,
    expected: { status: DeliveryStatus; attempts: number },
  ): Promise<boolean>;
  findById(id: string): Promise<Delivery | undefined>;
  list(filter: DeliveryListFilter): Promise<Page<Delivery>>;
}

export interface DeliveryAttemptRepository {
  insert(attempt: DeliveryAttempt): Promise<void>;
  listByDelivery(deliveryId: string): Promise<DeliveryAttempt[]>;
}

export interface ApiKeyRepository {
  insert(apiKey: ApiKey): Promise<void>;
  /** The non-revoked key with this hash, if any. */
  findActiveByHash(keyHash: string): Promise<ApiKey | undefined>;
}

export interface Repositories {
  readonly apiKeys: ApiKeyRepository;
  readonly events: EventRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly deliveries: DeliveryRepository;
  readonly attempts: DeliveryAttemptRepository;
}

/** A delivery that the worker should attempt at `runAt`. */
export interface DeliveryJob {
  readonly deliveryId: string;
  readonly runAt: Date;
}

/** The work queue (pg-boss). Inside a unit of work, enqueued jobs commit or roll back with the data. */
export interface DeliveryQueue {
  enqueue(jobs: readonly DeliveryJob[]): Promise<void>;
}

export interface TransactionContext {
  readonly repositories: Repositories;
  readonly queue: DeliveryQueue;
}

/** Runs work atomically: every repository write and every enqueued job, or none of them. */
export interface UnitOfWork {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

/** Everything a channel needs to hand one event to one subscription. */
export interface OutgoingMessage {
  readonly event: Event;
  readonly subscription: Subscription;
  /** Signing secrets valid now (two during a rotation's grace period). */
  readonly secrets: readonly string[];
  readonly now: Date;
}

export interface ChannelResult {
  readonly outcome: AttemptOutcome;
  /** Start of the destination's response body (at most 1 KB), for debugging. */
  readonly responseSnippet: string | null;
  readonly durationMs: number;
}

/** A way of delivering: webhook (HTTP), e-mail or Telegram. Never throws for delivery failures. */
export interface DeliveryChannel {
  send(message: OutgoingMessage): Promise<ChannelResult>;
}

export type Channels = Partial<Record<Channel, DeliveryChannel>>;

/** Registration-time DNS check of a webhook host (SSRF): every resolved address must be public. */
export type HostChecker = (hostname: string) => Promise<'public' | 'not_public' | 'unresolvable'>;
