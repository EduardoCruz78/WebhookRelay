import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OutgoingMessage } from '../../../src/application/ports.js';
import { classifyOutcome } from '../../../src/domain/attempt-outcome.js';
import { TelegramChannel } from '../../../src/infrastructure/channels/telegram.js';
import { anEvent, aSubscription, NOW } from '../../support/builders.js';
import { FakeDestination } from '../../support/fake-destination.js';

/** The Telegram Bot API played by the fake server: same paths and JSON shapes as the real one. */
const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn';

let api: FakeDestination;
let channel: TelegramChannel;

beforeAll(async () => {
  api = await FakeDestination.start();
  channel = new TelegramChannel({ botToken: TOKEN, apiUrl: api.baseUrl, timeoutMs: 1_000 });
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.reset();
});

const message: OutgoingMessage = {
  event: anEvent(),
  subscription: aSubscription({ channel: 'telegram', target: '-1001234567890' }),
  secrets: [],
  now: NOW,
};

describe('telegram channel', () => {
  it('calls sendMessage with the chat id and a readable summary', async () => {
    api.respondWith({ status: 200, body: '{"ok":true,"result":{"message_id":1}}' });

    const result = await channel.send(message);

    expect(classifyOutcome(result.outcome)).toBe('success');
    const [request] = api.requests;
    expect(request?.path).toBe(`/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(request?.body ?? '{}') as { chat_id: string; text: string };
    expect(body.chat_id).toBe('-1001234567890');
    expect(body.text).toContain('Event: appointment.created');
  });

  it('treats "chat not found" (400) as permanent and keeps the explanation', async () => {
    api.respondWith({
      status: 400,
      body: '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
    });

    const result = await channel.send(message);

    expect(classifyOutcome(result.outcome)).toBe('permanent');
    expect(result.responseSnippet).toContain('chat not found');
  });

  it('honours retry_after from the body of a 429', async () => {
    api.respondWith({
      status: 429,
      body: '{"ok":false,"error_code":429,"parameters":{"retry_after":17}}',
    });

    const result = await channel.send(message);

    expect(result.outcome).toEqual({ kind: 'response', status: 429, retryAfterMs: 17_000 });
  });

  it('never lets the bot token reach the attempt history', async () => {
    api.respondWith({ status: 500, body: `upstream failed for /bot${TOKEN}/sendMessage` });

    const result = await channel.send(message);

    expect(result.responseSnippet).not.toContain(TOKEN);
    expect(result.responseSnippet).toContain('/bot<token>/sendMessage');
  });

  it('times out like the webhook channel', async () => {
    api.respondWith({ status: 200, delayMs: 3_000 });

    const result = await channel.send(message);

    expect(result.outcome).toEqual({ kind: 'timeout', timeoutMs: 1_000 });
  });
});
