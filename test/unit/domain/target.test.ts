import { describe, expect, it } from 'vitest';

import { validateTarget, type TargetPolicy } from '../../../src/domain/subscription.js';

const production: TargetPolicy = { allowPrivateNetworks: false, allowHttp: false };
const development: TargetPolicy = { allowPrivateNetworks: true, allowHttp: true };

describe('validateTarget: webhook (production policy)', () => {
  it('accepts a public https URL and drops the fragment', () => {
    expect(
      validateTarget('webhook', ' https://hooks.example.com/in?x=1#frag ', production),
    ).toEqual({
      ok: true,
      value: 'https://hooks.example.com/in?x=1',
    });
  });

  it.each([
    ['http://hooks.example.com/in', 'Must use https:'],
    ['ftp://hooks.example.com/in', 'Must use https:'],
    ['not a url', 'Must be an absolute URL.'],
    ['https://user:pass@hooks.example.com/', 'Must not contain credentials'],
  ])('rejects %j as malformed (400)', (target, message) => {
    const result = validateTarget('webhook', target, production);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'Subscription.InvalidTarget', type: 'validation' },
    });
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  it.each([
    'https://127.0.0.1/hook',
    'https://10.1.2.3/hook',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://localhost/hook',
    'https://api.localhost/hook',
    'https://printer.local/hook',
    'https://db.internal/hook',
    'https://intranet/hook',
  ])('refuses the internal target %s (SSRF, 422)', (target) => {
    expect(validateTarget('webhook', target, production)).toMatchObject({
      ok: false,
      error: { code: 'Subscription.InvalidTarget', type: 'business_rule' },
    });
  });

  it('rejects URLs longer than 2000 characters', () => {
    const long = `https://hooks.example.com/${'a'.repeat(2000)}`;

    expect(validateTarget('webhook', long, production).ok).toBe(false);
  });
});

describe('validateTarget: webhook (development policy)', () => {
  it('allows http and local targets', () => {
    expect(validateTarget('webhook', 'http://127.0.0.1:4000/hook', development)).toEqual({
      ok: true,
      value: 'http://127.0.0.1:4000/hook',
    });
    expect(validateTarget('webhook', 'http://receiver:8080/hook', development).ok).toBe(true);
  });
});

describe('validateTarget: email and telegram', () => {
  it('normalizes an e-mail address to lower case', () => {
    expect(validateTarget('email', ' Ops@Example.COM ', production)).toEqual({
      ok: true,
      value: 'ops@example.com',
    });
  });

  it.each(['ops', 'ops@', '@example.com', 'ops@example', 'two words@example.com'])(
    'rejects the e-mail %j',
    (target) => {
      expect(validateTarget('email', target, production).ok).toBe(false);
    },
  );

  it.each(['123456789', '-1001234567890', '@my_channel'])(
    'accepts the Telegram chat %j',
    (target) => {
      expect(validateTarget('telegram', target, production).ok).toBe(true);
    },
  );

  it.each(['', 'abc', '@ab', '12 34', 'https://t.me/x'])(
    'rejects the Telegram chat %j',
    (target) => {
      expect(validateTarget('telegram', target, production).ok).toBe(false);
    },
  );
});
