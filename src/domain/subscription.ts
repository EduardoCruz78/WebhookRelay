export type Channel = 'webhook' | 'email' | 'telegram';

export const CHANNELS: readonly Channel[] = ['webhook', 'email', 'telegram'];

/** Who wants to receive which events, and where. The signing secrets live apart (see signature.ts). */
export interface Subscription {
  readonly id: string;
  readonly name: string;
  readonly channel: Channel;
  /** URL (webhook), e-mail address (email) or chat id (telegram). */
  readonly target: string;
  /** Exact types (`appointment.created`), prefix wildcards (`appointment.*`) or `*` for everything. */
  readonly eventTypes: readonly string[];
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const PATTERN = /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/;

export function isValidEventTypePattern(pattern: string): boolean {
  return pattern.length <= 100 && PATTERN.test(pattern);
}

export function matchesEventType(patterns: readonly string[], type: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
    return pattern === type;
  });
}

/**
 * Every pattern that matches `type`: `*`, the type itself and each prefix wildcard.
 * `appointment.reminder.sent` → `*`, `appointment.reminder.sent`, `appointment.*`, `appointment.reminder.*`.
 * Lets the database find interested subscriptions with one array-overlap query.
 */
export function patternsMatching(type: string): string[] {
  const segments = type.split('.');
  const prefixes = segments.slice(0, -1).map((_, i) => `${segments.slice(0, i + 1).join('.')}.*`);
  return ['*', type, ...prefixes];
}

/** Rule D2: one delivery per active subscription interested in the event type. */
export function isInterestedIn(subscription: Subscription, type: string): boolean {
  return subscription.isActive && matchesEventType(subscription.eventTypes, type);
}
