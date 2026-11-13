import { describe, expect, it } from 'vitest';

import { classifyOutcome, describeOutcome } from '../../../src/domain/attempt-outcome.js';

const response = (status: number) => ({ kind: 'response' as const, status });

describe('classifyOutcome', () => {
  it.each([200, 201, 202, 204, 299])('treats HTTP %i as success (D3)', (status) => {
    expect(classifyOutcome(response(status))).toBe('success');
  });

  it.each([500, 502, 503, 504, 599])('retries HTTP %i (D4)', (status) => {
    expect(classifyOutcome(response(status))).toBe('retryable');
  });

  it.each([408, 429])('retries HTTP %i even though it is a 4xx (D4)', (status) => {
    expect(classifyOutcome(response(status))).toBe('retryable');
  });

  it.each([400, 401, 403, 404, 410, 413, 422])('does not retry HTTP %i (D5)', (status) => {
    expect(classifyOutcome(response(status))).toBe('permanent');
  });

  it.each([301, 302, 307, 308])(
    'treats redirect %i as permanent: redirects are never followed',
    (status) => {
      expect(classifyOutcome(response(status))).toBe('permanent');
    },
  );

  it('retries timeouts and network errors (D4)', () => {
    expect(classifyOutcome({ kind: 'timeout', timeoutMs: 10_000 })).toBe('retryable');
    expect(classifyOutcome({ kind: 'network_error', message: 'ECONNREFUSED' })).toBe('retryable');
  });
});

describe('describeOutcome', () => {
  it('produces a short human-readable reason', () => {
    expect(describeOutcome(response(503))).toBe('HTTP 503');
    expect(describeOutcome({ kind: 'timeout', timeoutMs: 10_000 })).toBe(
      'Timed out after 10000 ms',
    );
    expect(describeOutcome({ kind: 'network_error', message: 'ECONNRESET' })).toBe(
      'Network error: ECONNRESET',
    );
  });
});
