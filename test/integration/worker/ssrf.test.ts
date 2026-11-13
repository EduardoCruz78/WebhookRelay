import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OutgoingMessage } from '../../../src/application/ports.js';
import { USER_AGENT } from '../../../src/composition.js';
import { checkHost } from '../../../src/infrastructure/channels/ssrf.js';
import { WebhookChannel } from '../../../src/infrastructure/channels/webhook.js';
import { generateSecret } from '../../../src/domain/signature.js';
import { anEvent, aSubscription, NOW } from '../../support/builders.js';
import { FakeDestination } from '../../support/fake-destination.js';

/**
 * The connection-time half of the SSRF protection, against a real server on 127.0.0.1:
 * the channel must refuse to connect, even though the server is up and would answer 200.
 */
let destination: FakeDestination;
const protectedChannel = new WebhookChannel({
  timeoutMs: 2_000,
  userAgent: USER_AGENT,
  allowPrivateNetworks: false,
});

beforeAll(async () => {
  destination = await FakeDestination.start();
});

afterAll(async () => {
  await destination.close();
});

beforeEach(() => {
  destination.reset();
});

const messageTo = (target: string): OutgoingMessage => ({
  event: anEvent(),
  subscription: aSubscription({ target }),
  secrets: [generateSecret()],
  now: NOW,
});

describe('webhook channel with SSRF protection', () => {
  it('refuses an IP literal in a private range without opening a connection', async () => {
    const result = await protectedChannel.send(messageTo(destination.url));

    expect(result.outcome).toEqual({
      kind: 'blocked',
      reason: '127.0.0.1 is not a public address',
    });
    expect(destination.requests).toHaveLength(0);
  });

  it('refuses a host name that resolves to loopback, checked at connection time', async () => {
    const port = new URL(destination.url).port;

    const result = await protectedChannel.send(messageTo(`http://localhost:${port}/hooks`));

    expect(result.outcome.kind).toBe('blocked');
    if (result.outcome.kind === 'blocked') {
      expect(result.outcome.reason).toMatch(/^localhost resolves to (127\.0\.0\.1|::1)/);
    }
    expect(destination.requests).toHaveLength(0);
  });

  it('reaches the same server when private networks are allowed (development)', async () => {
    const devChannel = new WebhookChannel({
      timeoutMs: 2_000,
      userAgent: USER_AGENT,
      allowPrivateNetworks: true,
    });

    const result = await devChannel.send(messageTo(destination.url));

    expect(result.outcome).toEqual({ kind: 'response', status: 200 });
    expect(destination.requests).toHaveLength(1);
  });
});

describe('checkHost (registration time)', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', '169.254.169.254', '10.0.0.1'])(
    'reports %s as not public',
    async (host) => {
      expect(await checkHost(host)).toBe('not_public');
    },
  );

  it('reports a public IP literal as public without any DNS query', async () => {
    expect(await checkHost('8.8.8.8')).toBe('public');
  });

  it('reports a name that cannot exist as unresolvable', async () => {
    // .invalid is reserved by RFC 2606 and never resolves.
    expect(await checkHost('relay-test.invalid')).toBe('unresolvable');
  });
});
