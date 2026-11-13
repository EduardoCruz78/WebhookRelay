import { describe, expect, it } from 'vitest';

import { generateApiKey, hashApiKey, isValidSource } from '../../../src/domain/api-key.js';

describe('generateApiKey', () => {
  it('produces a prefixed, URL-safe key with 256 random bits', () => {
    const key = generateApiKey();

    expect(key).toMatch(/^wr_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key.slice(3), 'base64url')).toHaveLength(32);
    expect(generateApiKey()).not.toBe(key);
  });
});

describe('hashApiKey', () => {
  it('is a deterministic SHA-256 hex digest', () => {
    // Same value as `printf wr_test | sha256sum`.
    expect(hashApiKey('wr_test')).toBe(
      '1119e0b1f7c2b94b8cace87a0f07b4bef7067ef8e2f0912f569e744a715272f7',
    );
    expect(hashApiKey('wr_tesT')).not.toBe(hashApiKey('wr_test'));
  });
});

describe('isValidSource', () => {
  it.each(['scheduling-api', 'billing', 'a1'])('accepts %j', (source) => {
    expect(isValidSource(source)).toBe(true);
  });

  it.each(['', 'a', 'Scheduling', '1api', 'with space', 'under_score'])('rejects %j', (source) => {
    expect(isValidSource(source)).toBe(false);
  });
});
