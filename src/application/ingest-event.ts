import type { Clock } from '../domain/clock.js';
import { createDelivery } from '../domain/delivery.js';
import type { Event } from '../domain/event.js';
import type { JsonObject } from '../domain/json.js';
import type { UnitOfWork } from './ports.js';

export interface IngestEventCommand {
  /** Taken from the authenticated API key, never from the request body. */
  readonly source: string;
  /** The event id in the source system; becomes the idempotency key. */
  readonly externalId: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly data: JsonObject;
}

export type IngestEventResult =
  | { readonly status: 'created'; readonly event: Event; readonly deliveryCount: number }
  | { readonly status: 'duplicate'; readonly event: Event };

export interface IngestEventDeps {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly newId: () => string;
}

/**
 * Stores the event, fans it out to one delivery per interested subscription and enqueues those
 * deliveries, all in one transaction. Either everything is recorded or nothing is, so an event can
 * never be stored without its deliveries, nor a job exist for an event that was rolled back.
 */
export async function ingestEvent(
  command: IngestEventCommand,
  deps: IngestEventDeps,
): Promise<IngestEventResult> {
  const now = deps.clock.now();

  return deps.unitOfWork.run(async ({ repositories, queue }) => {
    const { inserted, event } = await repositories.events.insertIfAbsent({
      id: deps.newId(),
      source: command.source,
      type: command.type,
      payload: command.data,
      occurredAt: command.occurredAt,
      receivedAt: now,
      idempotencyKey: command.externalId,
    });

    // D1: a repeat (e.g. the outbox re-sending after a lost acknowledgement) creates nothing.
    if (!inserted) return { status: 'duplicate', event };

    const subscriptions = await repositories.subscriptions.findInterestedIn(event.type);
    const deliveries = await repositories.deliveries.insertMany(
      subscriptions.map((subscription) =>
        createDelivery({
          id: deps.newId(),
          eventId: event.id,
          subscriptionId: subscription.id,
          now,
        }),
      ),
    );
    await queue.enqueue(deliveries.map((delivery) => ({ deliveryId: delivery.id, runAt: now })));

    return { status: 'created', event, deliveryCount: deliveries.length };
  });
}
