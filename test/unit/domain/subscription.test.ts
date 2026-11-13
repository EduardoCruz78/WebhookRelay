import { describe, expect, it } from 'vitest';

import { isValidEventType } from '../../../src/domain/event.js';
import {
  isInterestedIn,
  isValidEventTypePattern,
  matchesEventType,
  patternsMatching,
} from '../../../src/domain/subscription.js';
import { aSubscription } from '../../support/builders.js';

describe('matchesEventType', () => {
  it('matches exact types only', () => {
    expect(matchesEventType(['appointment.created'], 'appointment.created')).toBe(true);
    expect(matchesEventType(['appointment.created'], 'appointment.cancelled')).toBe(false);
  });

  it('matches everything with *', () => {
    expect(matchesEventType(['*'], 'appointment.created')).toBe(true);
    expect(matchesEventType(['*'], 'user.registered')).toBe(true);
  });

  it('matches a prefix wildcard on segment boundaries only', () => {
    expect(matchesEventType(['appointment.*'], 'appointment.created')).toBe(true);
    expect(matchesEventType(['appointment.*'], 'appointment.reminder.sent')).toBe(true);
    expect(matchesEventType(['appointment.*'], 'appointments.created')).toBe(false);
    expect(matchesEventType(['appointment.*'], 'appointment')).toBe(false);
  });

  it('matches if any pattern in the list matches', () => {
    expect(matchesEventType(['user.*', 'appointment.cancelled'], 'appointment.cancelled')).toBe(
      true,
    );
  });

  it('matches nothing with an empty list', () => {
    expect(matchesEventType([], 'appointment.created')).toBe(false);
  });
});

describe('patternsMatching', () => {
  it('lists the wildcard, the exact type and every prefix wildcard', () => {
    expect(patternsMatching('appointment.reminder.sent')).toEqual([
      '*',
      'appointment.reminder.sent',
      'appointment.*',
      'appointment.reminder.*',
    ]);
  });

  it('agrees with matchesEventType for every pattern it lists, and for none it omits', () => {
    const type = 'appointment.reminder.sent';
    const candidates = [
      '*',
      'appointment.*',
      'appointment.reminder.*',
      type,
      'user.*',
      'appointment.created',
    ];

    for (const pattern of candidates) {
      expect(patternsMatching(type).includes(pattern)).toBe(matchesEventType([pattern], type));
    }
  });
});

describe('isInterestedIn (D2)', () => {
  it('is true for an active subscription whose filter matches', () => {
    expect(isInterestedIn(aSubscription(), 'appointment.created')).toBe(true);
  });

  it('is false for an inactive subscription, even if the filter matches', () => {
    expect(isInterestedIn(aSubscription({ isActive: false }), 'appointment.created')).toBe(false);
  });

  it('is false when the filter does not match', () => {
    expect(isInterestedIn(aSubscription(), 'appointment.cancelled')).toBe(false);
  });
});

describe('validation', () => {
  it.each(['*', 'appointment.*', 'appointment.created', 'appointment', 'a.b_c.d'])(
    'accepts the pattern %j',
    (pattern) => {
      expect(isValidEventTypePattern(pattern)).toBe(true);
    },
  );

  it.each(['', '**', 'appointment.', '*.created', 'Appointment.Created', 'a..b', 'a.*.b', 'a b'])(
    'rejects the pattern %j',
    (pattern) => {
      expect(isValidEventTypePattern(pattern)).toBe(false);
    },
  );

  it.each(['appointment.created', 'appointment.reminder.sent', 'user_account.deleted'])(
    'accepts the event type %j',
    (type) => {
      expect(isValidEventType(type)).toBe(true);
    },
  );

  it.each([
    '',
    'appointment',
    'appointment.*',
    'Appointment.created',
    '.created',
    'a'.repeat(101) + '.b',
  ])('rejects the event type %j', (type) => {
    expect(isValidEventType(type)).toBe(false);
  });
});
