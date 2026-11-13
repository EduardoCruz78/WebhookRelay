import { describe, expect, it } from 'vitest';

import {
  backoffCeilingMs,
  DEFAULT_RETRY_POLICY,
  nextDelayMs,
  parseRetryAfter,
} from '../../../src/domain/retry-policy.js';
import { NOW } from '../../support/builders.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('backoffCeilingMs', () => {
  it('grows exponentially from 30 s and caps at 6 h (D4)', () => {
    const ceilings = [1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffCeilingMs(attempt));

    expect(ceilings).toEqual([
      30 * SECOND,
      2 * MINUTE,
      8 * MINUTE,
      32 * MINUTE,
      128 * MINUTE,
      6 * HOUR,
      6 * HOUR,
    ]);
  });

  it('never exceeds the cap, even for very large attempts', () => {
    expect(backoffCeilingMs(1_000)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects attempt %s', (attempt) => {
    expect(() => backoffCeilingMs(attempt)).toThrow(RangeError);
  });
});

describe('nextDelayMs (full jitter)', () => {
  it('returns the ceiling when random is just below 1', () => {
    expect(nextDelayMs(3, () => 0.999_999_999)).toBe(8 * MINUTE - 1);
  });

  it('scales linearly with the random value', () => {
    expect(nextDelayMs(2, () => 0.5)).toBe(1 * MINUTE);
  });

  it('applies the minimum delay when random is 0', () => {
    expect(nextDelayMs(1, () => 0)).toBe(DEFAULT_RETRY_POLICY.minDelayMs);
  });

  it('always stays within [min, ceiling) across many random draws', () => {
    for (let attempt = 1; attempt <= 7; attempt++) {
      for (let i = 0; i < 200; i++) {
        const delay = nextDelayMs(attempt, Math.random);
        expect(delay).toBeGreaterThanOrEqual(DEFAULT_RETRY_POLICY.minDelayMs);
        expect(delay).toBeLessThan(backoffCeilingMs(attempt));
      }
    }
  });

  it('spreads retries of simultaneous failures instead of synchronizing them', () => {
    const draws = [0.1, 0.4, 0.7, 0.95];
    const delays = draws.map((value) => nextDelayMs(4, () => value));

    expect(new Set(delays).size).toBe(draws.length);
  });
});

describe('parseRetryAfter (D7)', () => {
  it('parses delay-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120 * SECOND);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
  });

  it('parses an HTTP date relative to now', () => {
    expect(parseRetryAfter('Mon, 07 Dec 2026 12:05:00 GMT', NOW)).toBe(5 * MINUTE);
  });

  it('turns a date in the past into zero', () => {
    expect(parseRetryAfter('Mon, 07 Dec 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  it.each([undefined, '', 'soon', '-5', '1.5'])('ignores %j', (header) => {
    expect(parseRetryAfter(header, NOW)).toBeUndefined();
  });
});
