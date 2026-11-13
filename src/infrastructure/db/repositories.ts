import { and, arrayOverlaps, asc, desc, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';

import type {
  DeliveryAttemptRepository,
  DeliveryListFilter,
  DeliveryRepository,
  EventRepository,
  Page,
  Repositories,
  SubscriptionRepository,
} from '../../application/ports.js';
import type { Delivery } from '../../domain/delivery.js';
import type { DeliveryAttempt } from '../../domain/delivery-attempt.js';
import type { Event } from '../../domain/event.js';
import { patternsMatching, type Subscription } from '../../domain/subscription.js';
import type { Db } from './database.js';
import {
  deliveries,
  deliveryAttempts,
  events,
  subscriptionSecrets,
  subscriptions,
} from './schema.js';

type EventRow = typeof events.$inferSelect;
type SubscriptionRow = typeof subscriptions.$inferSelect;
type DeliveryRow = typeof deliveries.$inferSelect;
type AttemptRow = typeof deliveryAttempts.$inferSelect;

const toEvent = (row: EventRow): Event => ({ ...row });

const toSubscription = (row: SubscriptionRow): Subscription => ({ ...row });

const toDelivery = (row: DeliveryRow): Delivery => ({ ...row });

const toAttempt = (row: AttemptRow): DeliveryAttempt => ({ ...row });

export function createRepositories(db: Db): Repositories {
  return {
    events: new DrizzleEventRepository(db),
    subscriptions: new DrizzleSubscriptionRepository(db),
    deliveries: new DrizzleDeliveryRepository(db),
    attempts: new DrizzleDeliveryAttemptRepository(db),
  };
}

class DrizzleEventRepository implements EventRepository {
  constructor(private readonly db: Db) {}

  async insertIfAbsent(event: Event): Promise<{ inserted: boolean; event: Event }> {
    // ON CONFLICT DO NOTHING lets the unique constraint arbitrate concurrent duplicates: exactly
    // one INSERT returns a row; the others return nothing and read the winner below.
    const [inserted] = await this.db.insert(events).values(event).onConflictDoNothing().returning();
    if (inserted) return { inserted: true, event: toEvent(inserted) };

    const [existing] = await this.db
      .select()
      .from(events)
      .where(and(eq(events.source, event.source), eq(events.idempotencyKey, event.idempotencyKey)));
    if (!existing) {
      throw new Error(`Event ${event.source}/${event.idempotencyKey} conflicted but was not found`);
    }
    return { inserted: false, event: toEvent(existing) };
  }

  async findById(id: string): Promise<Event | undefined> {
    const [row] = await this.db.select().from(events).where(eq(events.id, id));
    return row && toEvent(row);
  }
}

class DrizzleSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: Db) {}

  async insert(subscription: Subscription): Promise<void> {
    await this.db.insert(subscriptions).values({
      ...subscription,
      eventTypes: [...subscription.eventTypes],
    });
  }

  async update(subscription: Subscription): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({
        name: subscription.name,
        target: subscription.target,
        eventTypes: [...subscription.eventTypes],
        isActive: subscription.isActive,
        updatedAt: subscription.updatedAt,
      })
      .where(eq(subscriptions.id, subscription.id));
  }

  async findById(id: string): Promise<Subscription | undefined> {
    const [row] = await this.db.select().from(subscriptions).where(eq(subscriptions.id, id));
    return row && toSubscription(row);
  }

  async list(): Promise<Subscription[]> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
    return rows.map(toSubscription);
  }

  async findInterestedIn(eventType: string): Promise<Subscription[]> {
    // `event_types && ARRAY[...]`: served by the partial GIN index on active subscriptions.
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.isActive, true),
          arrayOverlaps(subscriptions.eventTypes, patternsMatching(eventType)),
        ),
      )
      .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
    return rows.map(toSubscription);
  }

  async addSecret(
    subscriptionId: string,
    secret: { id: string; value: string; createdAt: Date },
  ): Promise<void> {
    await this.db.insert(subscriptionSecrets).values({
      id: secret.id,
      subscriptionId,
      secret: secret.value,
      createdAt: secret.createdAt,
      expiresAt: null,
    });
  }

  async expireCurrentSecrets(subscriptionId: string, expiresAt: Date): Promise<void> {
    await this.db
      .update(subscriptionSecrets)
      .set({ expiresAt })
      .where(
        and(
          eq(subscriptionSecrets.subscriptionId, subscriptionId),
          isNull(subscriptionSecrets.expiresAt),
        ),
      );
  }

  async activeSecrets(subscriptionId: string, now: Date) {
    const rows = await this.db
      .select({ value: subscriptionSecrets.secret, expiresAt: subscriptionSecrets.expiresAt })
      .from(subscriptionSecrets)
      .where(
        and(
          eq(subscriptionSecrets.subscriptionId, subscriptionId),
          or(isNull(subscriptionSecrets.expiresAt), gt(subscriptionSecrets.expiresAt, now)),
        ),
      )
      .orderBy(desc(subscriptionSecrets.createdAt), desc(subscriptionSecrets.id));
    return rows;
  }
}

/** Keyset pagination cursor: the (createdAt, id) of the last item on the page. */
function encodeCursor(delivery: Delivery): string {
  return Buffer.from(JSON.stringify([delivery.createdAt.toISOString(), delivery.id])).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      const createdAt = new Date(parsed[0]);
      if (!Number.isNaN(createdAt.getTime())) return { createdAt, id: parsed[1] };
    }
  } catch {
    // Malformed cursors are reported as undefined and rejected by the caller.
  }
  return undefined;
}

export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';
}

class DrizzleDeliveryRepository implements DeliveryRepository {
  constructor(private readonly db: Db) {}

  async insertMany(items: readonly Delivery[]): Promise<Delivery[]> {
    if (items.length === 0) return [];
    const rows = await this.db
      .insert(deliveries)
      .values([...items])
      .onConflictDoNothing({ target: [deliveries.eventId, deliveries.subscriptionId] })
      .returning();
    return rows.map(toDelivery);
  }

  async update(delivery: Delivery): Promise<void> {
    await this.db
      .update(deliveries)
      .set({
        status: delivery.status,
        attempts: delivery.attempts,
        nextAttemptAt: delivery.nextAttemptAt,
        lastError: delivery.lastError,
        updatedAt: delivery.updatedAt,
      })
      .where(eq(deliveries.id, delivery.id));
  }

  async findById(id: string): Promise<Delivery | undefined> {
    const [row] = await this.db.select().from(deliveries).where(eq(deliveries.id, id));
    return row && toDelivery(row);
  }

  async list(filter: DeliveryListFilter): Promise<Page<Delivery>> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(deliveries.status, filter.status));
    if (filter.subscriptionId)
      conditions.push(eq(deliveries.subscriptionId, filter.subscriptionId));
    if (filter.eventId) conditions.push(eq(deliveries.eventId, filter.eventId));
    if (filter.cursor !== undefined) {
      const cursor = decodeCursor(filter.cursor);
      if (!cursor) throw new InvalidCursorError('Malformed pagination cursor');
      // Row-value comparison: strictly after the last item in (created_at DESC, id DESC) order.
      conditions.push(
        sql`(${deliveries.createdAt}, ${deliveries.id}) < (${cursor.createdAt}, ${cursor.id})`,
      );
    }

    // One extra row tells whether another page exists without a COUNT(*).
    const rows = await this.db
      .select()
      .from(deliveries)
      .where(and(...conditions))
      .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
      .limit(filter.limit + 1);

    const items = rows.slice(0, filter.limit).map(toDelivery);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > filter.limit && last ? encodeCursor(last) : null };
  }
}

class DrizzleDeliveryAttemptRepository implements DeliveryAttemptRepository {
  constructor(private readonly db: Db) {}

  async insert(attempt: DeliveryAttempt): Promise<void> {
    await this.db.insert(deliveryAttempts).values(attempt);
  }

  async listByDelivery(deliveryId: string): Promise<DeliveryAttempt[]> {
    const rows = await this.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, deliveryId))
      .orderBy(asc(deliveryAttempts.startedAt), asc(deliveryAttempts.id));
    return rows.map(toAttempt);
  }
}
