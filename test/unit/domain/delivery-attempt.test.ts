import { describe, expect, it } from 'vitest';

import { truncateUtf8 } from '../../../src/domain/delivery-attempt.js';
import { toWebhookMessage } from '../../../src/domain/webhook-message.js';
import { anEvent } from '../../support/builders.js';

describe('truncateUtf8', () => {
  it('keeps short text unchanged', () => {
    expect(truncateUtf8('ok', 1024)).toBe('ok');
  });

  it('cuts long text to the byte limit (1 KB by default)', () => {
    expect(Buffer.byteLength(truncateUtf8('x'.repeat(5000)))).toBe(1024);
  });

  it('never splits a multi-byte character', () => {
    // U+00E9 is 2 bytes in UTF-8: 3 bytes fit one of them plus half of another, which is dropped.
    expect(truncateUtf8('ééé', 3)).toBe('é');
    // An emoji is 4 bytes: only the leading "a" fits in 4 bytes.
    expect(truncateUtf8('a\u{1F600}b', 4)).toBe('a');
  });
});

describe('toWebhookMessage', () => {
  it('exposes the event with an ISO timestamp and the payload under data', () => {
    const event = anEvent();

    expect(toWebhookMessage(event)).toEqual({
      id: event.id,
      type: 'appointment.created',
      source: 'scheduling-api',
      occurredAt: '2026-12-07T12:00:00.000Z',
      data: event.payload,
    });
  });
});
