import { describe, expect, it } from 'vitest';

import { toNotification, truncateText } from '../../src/domain/notification.js';
import { smtpFailure } from '../../src/infrastructure/channels/email.js';
import { anEvent } from '../support/builders.js';

describe('toNotification', () => {
  it('summarizes the event and appends the payload as indented JSON', () => {
    const event = anEvent({ payload: { appointmentId: 'a-1' } });

    const { subject, text } = toNotification(event);

    expect(subject).toBe('[WebhookRelay] appointment.created from scheduling-api');
    expect(text).toBe(
      [
        'Event: appointment.created',
        'Source: scheduling-api',
        'Occurred at: 2026-12-07T12:00:00.000Z',
        `Event id: ${event.id}`,
        '',
        '{\n  "appointmentId": "a-1"\n}',
      ].join('\n'),
    );
  });
});

describe('truncateText', () => {
  it('keeps short text unchanged', () => {
    expect(truncateText('hello', 10)).toBe('hello');
  });

  it('cuts to the limit and marks the cut', () => {
    const result = truncateText('x'.repeat(5000), 4096);

    expect(Array.from(result)).toHaveLength(4096);
    expect(result.endsWith('…(truncated)')).toBe(true);
  });

  it('counts emoji as one character and never splits them', () => {
    const result = truncateText('\u{1F600}'.repeat(30), 20);

    expect(Array.from(result)).toHaveLength(20);
    expect(result).not.toContain('�');
  });
});

describe('smtpFailure', () => {
  it('retries a temporary refusal (4xx)', () => {
    expect(smtpFailure({ responseCode: 451, response: '451 4.7.1 Try again later' }, 1000)).toEqual(
      {
        kind: 'rejected',
        retryable: true,
        reason: '451 4.7.1 Try again later',
      },
    );
  });

  it('does not retry a permanent refusal (5xx)', () => {
    expect(smtpFailure({ responseCode: 550, response: '550 5.1.1 No such user' }, 1000)).toEqual({
      kind: 'rejected',
      retryable: false,
      reason: '550 5.1.1 No such user',
    });
  });

  it('treats a timeout as a timeout', () => {
    expect(smtpFailure({ code: 'ETIMEDOUT', message: 'Greeting never received' }, 1000)).toEqual({
      kind: 'timeout',
      timeoutMs: 1000,
    });
  });

  it('does not retry an invalid recipient address', () => {
    expect(
      smtpFailure({ code: 'EENVELOPE', message: 'No recipients defined' }, 1000),
    ).toMatchObject({
      kind: 'rejected',
      retryable: false,
    });
  });

  it('retries connection problems', () => {
    expect(smtpFailure({ code: 'ESOCKET', message: 'connect ECONNREFUSED' }, 1000)).toEqual({
      kind: 'network_error',
      message: 'ESOCKET: connect ECONNREFUSED',
    });
  });
});
