import { createDelivery, type Delivery } from '../../src/domain/delivery.js';
import type { Event } from '../../src/domain/event.js';
import type { Subscription } from '../../src/domain/subscription.js';

/** Fixed "now" for deterministic tests: Monday, 2026-12-07 12:00 UTC. */
export const NOW = new Date('2026-12-07T12:00:00.000Z');

export const minutesAfter = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * 60_000);

export function anEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: '01938a2b-0000-7000-8000-000000000001',
    source: 'scheduling-api',
    type: 'appointment.created',
    payload: { appointmentId: 'a-1', startsAt: '2026-12-08T13:00:00Z' },
    occurredAt: NOW,
    receivedAt: NOW,
    idempotencyKey: 'outbox-1',
    ...overrides,
  };
}

export function aSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: '01938a2b-0000-7000-8000-0000000000a1',
    name: 'Partner webhook',
    channel: 'webhook',
    target: 'https://partner.example.com/hooks',
    eventTypes: ['appointment.created'],
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function aDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    ...createDelivery({
      id: '01938a2b-0000-7000-8000-0000000000d1',
      eventId: '01938a2b-0000-7000-8000-000000000001',
      subscriptionId: '01938a2b-0000-7000-8000-0000000000a1',
      now: NOW,
    }),
    ...overrides,
  };
}
