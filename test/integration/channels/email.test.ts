import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OutgoingMessage } from '../../../src/application/ports.js';
import { EmailChannel } from '../../../src/infrastructure/channels/email.js';
import { anEvent, aSubscription, NOW } from '../../support/builders.js';

/**
 * The e-mail channel against a real SMTP server: Mailpit, the same one docker-compose runs.
 * Mailpit is told to accept only @example.com recipients, so a 550 rejection can be provoked.
 */
let mailpit: StartedTestContainer;
let channel: EmailChannel;
let api: string;

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  From: { Address: string; Name: string };
}

beforeAll(async () => {
  mailpit = await new GenericContainer('axllent/mailpit:v1.27')
    .withExposedPorts(1025, 8025)
    .withEnvironment({ MP_SMTP_ALLOWED_RECIPIENTS: '@example\\.com$' })
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
  api = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1`;
  channel = new EmailChannel({
    smtpUrl: `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
    from: 'WebhookRelay <relay@test.local>',
    timeoutMs: 5_000,
  });
}, 120_000);

afterAll(async () => {
  channel.close();
  await mailpit.stop();
});

beforeEach(async () => {
  await fetch(`${api}/messages`, { method: 'DELETE' });
});

const messageTo = (address: string): OutgoingMessage => ({
  event: anEvent({ payload: { appointmentId: 'a-7' } }),
  subscription: aSubscription({ channel: 'email', target: address }),
  secrets: [],
  now: NOW,
});

async function inbox(): Promise<MailpitMessage[]> {
  const response = await fetch(`${api}/messages`);
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

describe('email channel (Mailpit)', () => {
  it('delivers the event as an e-mail with the webhook id header', async () => {
    const result = await channel.send(messageTo('ops@example.com'));

    expect(result.outcome.kind).toBe('accepted');
    const [message] = await inbox();
    expect(message?.Subject).toBe('[WebhookRelay] appointment.created from scheduling-api');
    expect(message?.To.map((to) => to.Address)).toEqual(['ops@example.com']);
    expect(message?.From).toMatchObject({ Address: 'relay@test.local', Name: 'WebhookRelay' });

    const headers = (await (
      await fetch(`${api}/message/${message?.ID ?? ''}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers['X-Webhook-Id']).toEqual([anEvent().id]);
    const text = (await (await fetch(`${api}/message/${message?.ID ?? ''}`)).json()) as {
      Text: string;
    };
    expect(text.Text).toContain('"appointmentId": "a-7"');
  });

  it('turns an SMTP 550 rejection into a permanent failure', async () => {
    const result = await channel.send(messageTo('someone@not-allowed.test'));

    expect(result.outcome).toMatchObject({ kind: 'rejected', retryable: false });
    if (result.outcome.kind === 'rejected') expect(result.outcome.reason).toMatch(/^550/);
    expect(await inbox()).toEqual([]);
  });

  it('turns an unreachable SMTP server into a retryable network error', async () => {
    const down = new EmailChannel({
      smtpUrl: 'smtp://127.0.0.1:1',
      from: 'relay@test.local',
      timeoutMs: 2_000,
    });

    const result = await down.send(messageTo('ops@example.com'));
    down.close();

    expect(result.outcome.kind).toBe('network_error');
  });
});
