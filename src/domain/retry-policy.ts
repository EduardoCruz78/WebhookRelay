import type { RandomSource } from './clock.js';

export interface RetryPolicy {
  /** Total attempts before a delivery goes to the dead-letter state (D6). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
  /** Lower bound for any computed delay, so full jitter never retries instantly. */
  readonly minDelayMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Ceilings after attempts 1..7: 30 s, 2 min, 8 min, 32 min, ~2 h, 6 h, 6 h (D4). */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 30 * SECOND,
  multiplier: 4,
  maxDelayMs: 6 * HOUR,
  minDelayMs: 1 * SECOND,
};

/** Upper bound of the wait after the given (1-based) failed attempt: exponential with a cap. */
export function backoffCeilingMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  const exponential = policy.baseDelayMs * policy.multiplier ** (attempt - 1);
  return Math.min(policy.maxDelayMs, exponential);
}

/**
 * Full jitter: a uniformly random wait in [0, ceiling). Spreading retries out prevents every
 * delivery that failed during the same outage from hitting the destination at the same instant
 * (thundering herd) when it comes back.
 */
export function nextDelayMs(
  attempt: number,
  random: RandomSource,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  const jittered = Math.floor(random() * backoffCeilingMs(attempt, policy));
  return Math.max(policy.minDelayMs, jittered);
}

/**
 * Parses an HTTP `Retry-After` header (delay in seconds or an HTTP date) into milliseconds from
 * `now`. Returns undefined when absent or malformed; dates in the past become 0.
 */
export function parseRetryAfter(header: string | undefined, now: Date): number | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  if (value === '') return undefined;

  if (/^\d+$/.test(value)) return Number(value) * SECOND;

  // Only the IMF-fixdate form ("Mon, 07 Dec 2026 12:05:00 GMT"): Date.parse alone is far too
  // lenient and would read "1.5" or "-5" as dates.
  if (!IMF_FIXDATE.test(value)) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}
