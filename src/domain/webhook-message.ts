import type { Event } from './event.js';

/** The JSON body every webhook destination receives. Stable contract: add fields, never rename. */
export interface WebhookMessage {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly data: Event['payload'];
}

export function toWebhookMessage(event: Event): WebhookMessage {
  return {
    id: event.id,
    type: event.type,
    source: event.source,
    occurredAt: event.occurredAt.toISOString(),
    data: event.payload,
  };
}
