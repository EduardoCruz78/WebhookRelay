import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import type { JsonObject } from '../../domain/json.js';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull();

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    source: text('source').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (table) => [
    // D1: the database itself refuses a second event with the same source + idempotency key.
    unique('events_source_idempotency_key_unique').on(table.source, table.idempotencyKey),
    index('events_received_at_idx').on(table.receivedAt),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    channel: text('channel', { enum: ['webhook', 'email', 'telegram'] }).notNull(),
    target: text('target').notNull(),
    eventTypes: text('event_types').array().notNull(),
    isActive: boolean('is_active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('subscriptions_channel_check', sql`${table.channel} in ('webhook', 'email', 'telegram')`),
    check('subscriptions_event_types_not_empty', sql`cardinality(${table.eventTypes}) > 0`),
    // Fan-out runs `event_types && ARRAY[...]` on every ingested event: a GIN index answers
    // array-overlap queries, and the partial WHERE keeps inactive subscriptions out of it.
    index('subscriptions_active_event_types_idx')
      .using('gin', table.eventTypes)
      .where(sql`${table.isActive}`),
  ],
);

export const subscriptionSecrets = pgTable(
  'subscription_secrets',
  {
    id: uuid('id').primaryKey(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    createdAt: createdAt(),
    /** Null for the current secret; set to now + 24 h on the previous one after a rotation. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [index('subscription_secrets_subscription_idx').on(table.subscriptionId)],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    status: text('status', { enum: ['pending', 'failed', 'succeeded', 'dead'] }).notNull(),
    attempts: integer('attempts').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // D2: fan-out can never create two deliveries of the same event to the same subscription.
    unique('deliveries_event_subscription_unique').on(table.eventId, table.subscriptionId),
    check(
      'deliveries_status_check',
      sql`${table.status} in ('pending', 'failed', 'succeeded', 'dead')`,
    ),
    check('deliveries_attempts_check', sql`${table.attempts} >= 0`),
    // GET /deliveries?status=dead&subscriptionId=... (the dead-letter view), newest first.
    index('deliveries_status_created_idx').on(table.status, table.createdAt),
    index('deliveries_subscription_created_idx').on(table.subscriptionId, table.createdAt),
  ],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').primaryKey(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    httpStatus: integer('http_status'),
    error: text('error'),
    responseSnippet: text('response_snippet'),
  },
  (table) => [
    check('delivery_attempts_attempt_number_check', sql`${table.attemptNumber} >= 1`),
    check('delivery_attempts_duration_check', sql`${table.durationMs} >= 0`),
    index('delivery_attempts_delivery_started_idx').on(table.deliveryId, table.startedAt),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    role: text('role', { enum: ['source', 'admin'] }).notNull(),
    source: text('source'),
    keyHash: text('key_hash').notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // Every request looks its key up by hash.
    unique('api_keys_key_hash_unique').on(table.keyHash),
    check('api_keys_role_check', sql`${table.role} in ('source', 'admin')`),
    check(
      'api_keys_source_required_for_source_role',
      sql`(${table.role} = 'source') = (${table.source} is not null)`,
    ),
  ],
);
