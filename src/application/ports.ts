import type { Delivery, DeliveryStatus } from '../domain/delivery.js';
import type { DeliveryAttempt } from '../domain/delivery-attempt.js';
import type { Event } from '../domain/event.js';
import type { SigningSecret } from '../domain/signature.js';
import type { Subscription } from '../domain/subscription.js';

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

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface DeliveryRepository {
  /** Inserts deliveries, skipping any (event, subscription) pair that already exists. Returns the inserted ones. */
  insertMany(deliveries: readonly Delivery[]): Promise<Delivery[]>;
  update(delivery: Delivery): Promise<void>;
  findById(id: string): Promise<Delivery | undefined>;
  list(filter: DeliveryListFilter): Promise<Page<Delivery>>;
}

export interface DeliveryAttemptRepository {
  insert(attempt: DeliveryAttempt): Promise<void>;
  listByDelivery(deliveryId: string): Promise<DeliveryAttempt[]>;
}

export interface Repositories {
  readonly events: EventRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly deliveries: DeliveryRepository;
  readonly attempts: DeliveryAttemptRepository;
}
