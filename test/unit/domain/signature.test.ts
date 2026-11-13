import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';

import {
  activeSecrets,
  generateSecret,
  isValidSecret,
  sign,
  signatureHeader,
  verify,
  type SignedContent,
} from '../../../src/domain/signature.js';
import { minutesAfter, NOW } from '../../support/builders.js';

// Fixed key so that the expected signature below is a known constant.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const content: SignedContent = {
  messageId: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: nowSeconds,
  body: '{"test": 2432232314}',
};

function headersFor(secret: string, signed: SignedContent = content) {
  return {
    messageId: signed.messageId,
    timestamp: String(signed.timestamp),
    signature: sign(secret, signed),
    body: signed.body,
  };
}

describe('sign', () => {
  it('matches the reference vector of the Standard Webhooks specification', () => {
    // Test vector from the standard-webhooks repository (timestamp 1614265330).
    const signature = sign(SECRET, { ...content, timestamp: 1_614_265_330 });

    expect(signature).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('changes when any signed part changes', () => {
    const original = sign(SECRET, content);

    expect(sign(SECRET, { ...content, body: content.body + ' ' })).not.toBe(original);
    expect(sign(SECRET, { ...content, timestamp: content.timestamp + 1 })).not.toBe(original);
    expect(sign(SECRET, { ...content, messageId: 'msg_other' })).not.toBe(original);
    expect(sign(generateSecret(), content)).not.toBe(original);
  });

  it('rejects a malformed secret', () => {
    expect(() => sign('not-a-secret', content)).toThrow(RangeError);
  });
});

describe('generateSecret', () => {
  it('produces a whsec_ secret with 32 random bytes', () => {
    const secret = generateSecret();

    expect(isValidSecret(secret)).toBe(true);
    expect(Buffer.from(secret.slice('whsec_'.length), 'base64')).toHaveLength(32);
    expect(generateSecret()).not.toBe(secret);
  });

  it.each(['', 'whsec_', 'whsec_short', 'sk_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'whsec_***'])(
    'rejects %j as a secret',
    (secret) => {
      expect(isValidSecret(secret)).toBe(false);
    },
  );
});

describe('verify', () => {
  it('accepts a correctly signed request', () => {
    const result = verify({ secrets: [SECRET], now: NOW, ...headersFor(SECRET) });

    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const result = verify({
      secrets: [SECRET],
      now: NOW,
      ...headersFor(SECRET),
      body: '{"test": 1}',
    });

    expect(result).toEqual({ ok: false, error: 'invalid_signature' });
  });

  it('rejects a signature made with another secret', () => {
    const result = verify({ secrets: [SECRET], now: NOW, ...headersFor(generateSecret()) });

    expect(result).toEqual({ ok: false, error: 'invalid_signature' });
  });

  it('rejects replays older than the 5-minute tolerance', () => {
    const result = verify({ secrets: [SECRET], now: minutesAfter(NOW, 6), ...headersFor(SECRET) });

    expect(result).toEqual({ ok: false, error: 'timestamp_out_of_tolerance' });
  });

  it('rejects timestamps too far in the future', () => {
    const result = verify({ secrets: [SECRET], now: minutesAfter(NOW, -6), ...headersFor(SECRET) });

    expect(result).toEqual({ ok: false, error: 'timestamp_out_of_tolerance' });
  });

  it('accepts a request within the tolerance window', () => {
    const result = verify({ secrets: [SECRET], now: minutesAfter(NOW, 4), ...headersFor(SECRET) });

    expect(result.ok).toBe(true);
  });

  it('rejects missing headers and non-numeric timestamps', () => {
    const headers = headersFor(SECRET);

    expect(verify({ secrets: [SECRET], now: NOW, ...headers, signature: undefined })).toEqual({
      ok: false,
      error: 'missing_headers',
    });
    expect(verify({ secrets: [SECRET], now: NOW, ...headers, timestamp: '12abc' })).toEqual({
      ok: false,
      error: 'invalid_timestamp',
    });
  });

  it('ignores signatures with an unknown version', () => {
    const headers = headersFor(SECRET);
    const result = verify({
      secrets: [SECRET],
      now: NOW,
      ...headers,
      signature: headers.signature.replace('v1,', 'v2,'),
    });

    expect(result).toEqual({ ok: false, error: 'invalid_signature' });
  });
});

describe('secret rotation', () => {
  const oldSecret = SECRET;
  const newSecret = generateSecret();
  const secrets = [
    { value: newSecret, expiresAt: null },
    { value: oldSecret, expiresAt: minutesAfter(NOW, 24 * 60) },
  ];

  it('signs with both secrets during the 24 h grace period', () => {
    expect(activeSecrets(secrets, NOW)).toEqual([newSecret, oldSecret]);
  });

  it('drops the old secret once it expires', () => {
    expect(activeSecrets(secrets, minutesAfter(NOW, 24 * 60))).toEqual([newSecret]);
  });

  it('lets a receiver that still has only the old secret verify the request', () => {
    const header = signatureHeader(activeSecrets(secrets, NOW), content);

    expect(header.split(' ')).toHaveLength(2);
    expect(
      verify({
        secrets: [oldSecret],
        now: NOW,
        messageId: content.messageId,
        timestamp: String(content.timestamp),
        signature: header,
        body: content.body,
      }).ok,
    ).toBe(true);
  });

  it('requires at least one secret to sign', () => {
    expect(() => signatureHeader([], content)).toThrow(RangeError);
  });
});

describe('contract with the official Standard Webhooks library', () => {
  const fresh = (): SignedContent => ({
    messageId: 'evt_contract',
    timestamp: Math.floor(Date.now() / 1000),
    body: JSON.stringify({ id: 'evt_contract', type: 'appointment.created', data: { a: 1 } }),
  });

  it('our signature is accepted by the standardwebhooks verifier', () => {
    const signed = fresh();
    const headers = {
      'webhook-id': signed.messageId,
      'webhook-timestamp': String(signed.timestamp),
      'webhook-signature': signatureHeader([SECRET, generateSecret()], signed),
    };

    expect(() => new Webhook(SECRET).verify(signed.body, headers)).not.toThrow();
  });

  it('their signature is accepted by our verifier', () => {
    const signed = fresh();
    const signature = new Webhook(SECRET).sign(
      signed.messageId,
      new Date(signed.timestamp * 1000),
      signed.body,
    );

    const result = verify({
      secrets: [SECRET],
      now: new Date(),
      messageId: signed.messageId,
      timestamp: String(signed.timestamp),
      signature,
      body: signed.body,
    });

    expect(result.ok).toBe(true);
  });
});
