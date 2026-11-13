import type { JsonObject } from './json.js';

/** Something that happened in a source system, e.g. `appointment.created` from `scheduling-api`. */
export interface Event {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  /** The event id in the source system. Unique per `source` (rule D1). */
  readonly idempotencyKey: string;
}

/** Dot-separated lowercase segments with at least two parts: `appointment.created`. */
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function isValidEventType(type: string): boolean {
  return type.length <= 100 && EVENT_TYPE.test(type);
}
