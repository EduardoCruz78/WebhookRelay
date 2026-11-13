import type {
  ApiKeyRepository,
  DeliveryAttemptRepository,
  DeliveryJob,
  DeliveryListFilter,
  DeliveryQueue,
  DeliveryRepository,
  EventRepository,
  Page,
  Repositories,
  SubscriptionRepository,
  TransactionContext,
  UnitOfWork,
} from '../../src/application/ports.js';
import type { ApiKey } from '../../src/domain/api-key.js';
import type { Clock } from '../../src/domain/clock.js';
import type { Delivery } from '../../src/domain/delivery.js';
import type { DeliveryAttempt } from '../../src/domain/delivery-attempt.js';
import type { Event } from '../../src/domain/event.js';
import type { SigningSecret } from '../../src/domain/signature.js';
import { isInterestedIn, type Subscription } from '../../src/domain/subscription.js';

/**
 * Hand-written in-memory fakes (same approach as SchedulingApi): they store and return data like
 * the real repositories, so tests describe behaviour instead of verifying mock calls.
 */
interface State {
  apiKeys: Map<string, ApiKey>;
  events: Map<string, Event>;
  subscriptions: Map<string, Subscription>;
  secrets: {
    subscriptionId: string;
    id: string;
    value: string;
    createdAt: Date;
    expiresAt: Date | null;
  }[];
  deliveries: Map<string, Delivery>;
  attempts: DeliveryAttempt[];
  jobs: DeliveryJob[];
}

const emptyState = (): State => ({
  apiKeys: new Map(),
  events: new Map(),
  subscriptions: new Map(),
  secrets: [],
  deliveries: new Map(),
  attempts: [],
  jobs: [],
});

export class FakeStore {
  state: State = emptyState();

  readonly repositories: Repositories = {
    apiKeys: new FakeApiKeys(this),
    events: new FakeEvents(this),
    subscriptions: new FakeSubscriptions(this),
    deliveries: new FakeDeliveries(this),
    attempts: new FakeAttempts(this),
  };

  readonly queue: DeliveryQueue = {
    enqueue: async (jobs) => {
      this.state.jobs.push(...jobs);
    },
  };

  /** Snapshot-and-restore gives the fake the same all-or-nothing behaviour as a transaction. */
  readonly unitOfWork: UnitOfWork = {
    run: async <T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(this.state);
      try {
        return await work({ repositories: this.repositories, queue: this.queue });
      } catch (error) {
        this.state = snapshot;
        throw error;
      }
    },
  };
}

class FakeApiKeys implements ApiKeyRepository {
  constructor(private readonly store: FakeStore) {}
  async insert(apiKey: ApiKey) {
    this.store.state.apiKeys.set(apiKey.id, apiKey);
  }
  async findActiveByHash(keyHash: string) {
    return [...this.store.state.apiKeys.values()].find(
      (key) => key.keyHash === keyHash && key.revokedAt === null,
    );
  }
}

class FakeEvents implements EventRepository {
  constructor(private readonly store: FakeStore) {}
  async insertIfAbsent(event: Event) {
    const existing = [...this.store.state.events.values()].find(
      (e) => e.source === event.source && e.idempotencyKey === event.idempotencyKey,
    );
    if (existing) return { inserted: false, event: existing };
    this.store.state.events.set(event.id, event);
    return { inserted: true, event };
  }
  async findById(id: string) {
    return this.store.state.events.get(id);
  }
}

class FakeSubscriptions implements SubscriptionRepository {
  constructor(private readonly store: FakeStore) {}
  async insert(subscription: Subscription) {
    this.store.state.subscriptions.set(subscription.id, subscription);
  }
  async update(subscription: Subscription) {
    this.store.state.subscriptions.set(subscription.id, subscription);
  }
  async findById(id: string) {
    return this.store.state.subscriptions.get(id);
  }
  async list() {
    return [...this.store.state.subscriptions.values()];
  }
  async findInterestedIn(eventType: string) {
    return [...this.store.state.subscriptions.values()].filter((s) => isInterestedIn(s, eventType));
  }
  async addSecret(subscriptionId: string, secret: { id: string; value: string; createdAt: Date }) {
    this.store.state.secrets.push({ subscriptionId, ...secret, expiresAt: null });
  }
  async expireCurrentSecrets(subscriptionId: string, expiresAt: Date) {
    for (const secret of this.store.state.secrets) {
      if (secret.subscriptionId === subscriptionId && secret.expiresAt === null) {
        secret.expiresAt = expiresAt;
      }
    }
  }
  async activeSecrets(subscriptionId: string, now: Date): Promise<SigningSecret[]> {
    return this.store.state.secrets
      .filter(
        (s) =>
          s.subscriptionId === subscriptionId &&
          (s.expiresAt === null || s.expiresAt.getTime() > now.getTime()),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((s) => ({ value: s.value, expiresAt: s.expiresAt }));
  }
}

class FakeDeliveries implements DeliveryRepository {
  constructor(private readonly store: FakeStore) {}
  async insertMany(items: readonly Delivery[]) {
    const inserted: Delivery[] = [];
    for (const item of items) {
      const duplicate = [...this.store.state.deliveries.values()].some(
        (d) => d.eventId === item.eventId && d.subscriptionId === item.subscriptionId,
      );
      if (!duplicate) {
        this.store.state.deliveries.set(item.id, item);
        inserted.push(item);
      }
    }
    return inserted;
  }
  async update(delivery: Delivery) {
    this.store.state.deliveries.set(delivery.id, delivery);
  }
  async findById(id: string) {
    return this.store.state.deliveries.get(id);
  }
  async list(filter: DeliveryListFilter): Promise<Page<Delivery>> {
    const items = [...this.store.state.deliveries.values()]
      .filter(
        (d) =>
          (!filter.status || d.status === filter.status) &&
          (!filter.subscriptionId || d.subscriptionId === filter.subscriptionId) &&
          (!filter.eventId || d.eventId === filter.eventId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, filter.limit);
    return { items, nextCursor: null };
  }
}

class FakeAttempts implements DeliveryAttemptRepository {
  constructor(private readonly store: FakeStore) {}
  async insert(attempt: DeliveryAttempt) {
    this.store.state.attempts.push(attempt);
  }
  async listByDelivery(deliveryId: string) {
    return this.store.state.attempts
      .filter((a) => a.deliveryId === deliveryId)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
}

/** A clock that only moves when the test says so. */
export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

/** Deterministic ids: id-1, id-2, ... */
export function sequentialIds(prefix = 'id'): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
