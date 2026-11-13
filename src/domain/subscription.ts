import { isIP } from 'node:net';

import { isPublicAddress, unbracket } from './network-policy.js';
import { err, ok, type DomainError, type Result } from './result.js';

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

export interface TargetPolicy {
  /** SSRF protection off: allow localhost and private networks (development only). */
  readonly allowPrivateNetworks: boolean;
  /** Allow plain http:// webhook URLs (development only). */
  readonly allowHttp: boolean;
}

const invalidTarget = (message: string): DomainError => ({
  code: 'Subscription.InvalidTarget',
  message,
  type: 'validation',
});

const LOCAL_HOSTNAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
/** A numeric chat id (negative for groups) or a public @channel username. */
const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/**
 * Checks the shape of a target for its channel and returns it normalized. For webhooks this is the
 * first SSRF line of defence (no credentials in the URL, no IP literal or local name pointing
 * inside); the DNS check at registration and the address check at connection time come after.
 */
export function validateTarget(
  channel: Channel,
  target: string,
  policy: TargetPolicy,
): Result<string> {
  const value = target.trim();
  switch (channel) {
    case 'email':
      return value.length <= 254 && EMAIL.test(value)
        ? ok(value.toLowerCase())
        : err(invalidTarget('Must be an e-mail address.'));
    case 'telegram':
      return TELEGRAM_CHAT.test(value)
        ? ok(value)
        : err(invalidTarget('Must be a Telegram chat id (e.g. -1001234567890) or @channel.'));
    case 'webhook':
      return validateWebhookUrl(value, policy);
  }
}

function validateWebhookUrl(value: string, policy: TargetPolicy): Result<string> {
  if (value.length > 2000) return err(invalidTarget('URL is too long (max 2000 characters).'));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return err(invalidTarget('Must be an absolute URL.'));
  }
  const allowedProtocols = policy.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    return err(invalidTarget(`Must use ${allowedProtocols.join(' or ')}.`));
  }
  if (url.username || url.password) {
    return err(invalidTarget('Must not contain credentials; use the signature to authenticate.'));
  }
  if (!policy.allowPrivateNetworks) {
    const host = unbracket(url.hostname);
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
      return err({ ...invalidTarget(`${host} is not a public address.`), type: 'business_rule' });
    }
    if (isIP(host) === 0 && (LOCAL_HOSTNAMES.test(host) || !host.includes('.'))) {
      return err({ ...invalidTarget(`${host} is not a public host name.`), type: 'business_rule' });
    }
  }
  url.hash = '';
  return ok(url.toString());
}
