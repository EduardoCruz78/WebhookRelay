import { performance } from 'node:perf_hooks';

import { request } from 'undici';

import type { ChannelResult, DeliveryChannel, OutgoingMessage } from '../../application/ports.js';
import type { AttemptOutcome } from '../../domain/attempt-outcome.js';
import { truncateUtf8 } from '../../domain/delivery-attempt.js';
import { TELEGRAM_MAX_LENGTH, toNotification, truncateText } from '../../domain/notification.js';
import { parseRetryAfter } from '../../domain/retry-policy.js';

export interface TelegramChannelOptions {
  readonly botToken: string;
  /** https://api.telegram.org in production; a fake server in tests. */
  readonly apiUrl: string;
  readonly timeoutMs: number;
}

/**
 * Bot API over plain HTTP (no SDK): POST /bot<token>/sendMessage. Telegram's answers map onto the
 * webhook rules: 400 (chat not found) and 403 (bot blocked) are permanent; 429 and 5xx are retried,
 * and on 429 Telegram says how long to wait in `parameters.retry_after`.
 */
export class TelegramChannel implements DeliveryChannel {
  constructor(private readonly options: TelegramChannelOptions) {}

  async send({ event, subscription, now }: OutgoingMessage): Promise<ChannelResult> {
    const { text } = toNotification(event);
    const url = `${this.options.apiUrl.replace(/\/$/, '')}/bot${this.options.botToken}/sendMessage`;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const response = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: subscription.target,
          text: truncateText(text, TELEGRAM_MAX_LENGTH),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const body = await response.body.text();
      const header = response.headers['retry-after'];
      const retryAfterMs =
        parseRetryAfter(Array.isArray(header) ? header[0] : header, now) ??
        retryAfterFromBody(body);
      const outcome: AttemptOutcome =
        retryAfterMs === undefined
          ? { kind: 'response', status: response.statusCode }
          : { kind: 'response', status: response.statusCode, retryAfterMs };
      return {
        outcome,
        responseSnippet: this.scrub(truncateUtf8(body)) || null,
        durationMs: elapsed(),
      };
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const outcome: AttemptOutcome = timedOut
        ? { kind: 'timeout', timeoutMs: this.options.timeoutMs }
        : { kind: 'network_error', message: this.scrub(describe(error)) };
      return { outcome, responseSnippet: null, durationMs: elapsed() };
    }
  }

  /** The token is part of the URL: make sure it can never reach the attempt history or logs. */
  private scrub(text: string): string {
    return text.split(this.options.botToken).join('<token>');
  }
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === 'string' ? `${code}: ${message}` : message;
}

/** Telegram puts the wait on 429 in the JSON body: {"parameters":{"retry_after":17}}. */
function retryAfterFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { parameters?: { retry_after?: unknown } };
    const seconds = parsed.parameters?.retry_after;
    return typeof seconds === 'number' && seconds >= 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}
