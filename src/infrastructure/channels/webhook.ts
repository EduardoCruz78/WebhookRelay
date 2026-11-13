import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';

import { request, type Dispatcher } from 'undici';

import type { ChannelResult, DeliveryChannel, OutgoingMessage } from '../../application/ports.js';
import type { AttemptOutcome } from '../../domain/attempt-outcome.js';
import { RESPONSE_SNIPPET_MAX_BYTES, truncateUtf8 } from '../../domain/delivery-attempt.js';
import { parseRetryAfter } from '../../domain/retry-policy.js';
import { signatureHeader } from '../../domain/signature.js';
import { toWebhookMessage } from '../../domain/webhook-message.js';
import { BlockedAddressError, blockedLiteral, createPublicOnlyAgent } from './ssrf.js';

export interface WebhookChannelOptions {
  /** D3: no 2xx within this time is a failure (and a retryable one). */
  readonly timeoutMs: number;
  readonly userAgent: string;
  /**
   * False in production: only public addresses are reachable (SSRF protection). True for local
   * development and tests, where receivers run on localhost or a Docker network.
   */
  readonly allowPrivateNetworks: boolean;
  /** Overrides the HTTP agent (tests). Defaults to an agent that refuses non-public addresses. */
  readonly dispatcher?: Dispatcher;
}

/**
 * POSTs the event as JSON with Standard Webhooks headers (rule D8):
 *   webhook-id: the event id, identical on every retry, so receivers can deduplicate (D9)
 *   webhook-timestamp: Unix seconds, signed together with the id and body
 *   webhook-signature: one `v1,<base64>` per active secret
 * Redirects are not followed: undici's request() does not follow them unless asked to.
 */
export class WebhookChannel implements DeliveryChannel {
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly options: WebhookChannelOptions) {
    this.dispatcher =
      options.dispatcher ?? (options.allowPrivateNetworks ? undefined : createPublicOnlyAgent());
  }

  async send({ event, subscription, secrets, now }: OutgoingMessage): Promise<ChannelResult> {
    const body = JSON.stringify(toWebhookMessage(event));
    const timestamp = Math.floor(now.getTime() / 1000);
    const headers = {
      'content-type': 'application/json',
      'user-agent': this.options.userAgent,
      'webhook-id': event.id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signatureHeader(secrets, { messageId: event.id, timestamp, body }),
    };

    if (!this.options.allowPrivateNetworks) {
      const literal = blockedLiteral(new URL(subscription.target));
      if (literal) {
        return {
          outcome: { kind: 'blocked', reason: `${literal} is not a public address` },
          responseSnippet: null,
          durationMs: 0,
        };
      }
    }

    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const response = await request(subscription.target, {
        method: 'POST',
        headers,
        body,
        // One deadline for connecting, sending and reading the response.
        signal: AbortSignal.timeout(this.options.timeoutMs),
        ...(this.dispatcher && { dispatcher: this.dispatcher }),
      });
      const snippet = await readSnippet(response.body);
      const retryAfterHeader = response.headers['retry-after'];
      const retryAfterMs = parseRetryAfter(
        Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader,
        now,
      );
      const outcome: AttemptOutcome =
        retryAfterMs === undefined
          ? { kind: 'response', status: response.statusCode }
          : { kind: 'response', status: response.statusCode, retryAfterMs };
      return { outcome, responseSnippet: snippet, durationMs: elapsed() };
    } catch (error) {
      return {
        outcome: toFailure(error, this.options.timeoutMs),
        responseSnippet: null,
        durationMs: elapsed(),
      };
    }
  }
}

function toFailure(error: unknown, timeoutMs: number): AttemptOutcome {
  const blocked = findBlocked(error);
  if (blocked) return { kind: 'blocked', reason: blocked.message };
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { kind: 'timeout', timeoutMs };
  }
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'network_error',
    message: typeof code === 'string' ? `${code}: ${message}` : message,
  };
}

/** Reads at most 1 KB of the response and discards the rest, so a huge body cannot exhaust memory. */
async function readSnippet(body: Readable): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(buffer);
    size += buffer.length;
    if (size >= RESPONSE_SNIPPET_MAX_BYTES) break;
  }
  // Leaving the loop early destroys the stream; undici then closes or reuses the socket.
  body.destroy();
  if (size === 0) return null;
  return truncateUtf8(Buffer.concat(chunks).toString('utf8'), RESPONSE_SNIPPET_MAX_BYTES);
}

/** undici may wrap the lookup error (in `cause`, or in an AggregateError when trying several IPs). */
function findBlocked(error: unknown, depth = 0): BlockedAddressError | undefined {
  if (error instanceof BlockedAddressError) return error;
  if (depth > 3 || !(error instanceof Error)) return undefined;
  const nested: unknown[] = error instanceof AggregateError ? (error.errors as unknown[]) : [];
  for (const candidate of [error.cause, ...nested]) {
    const found = findBlocked(candidate, depth + 1);
    if (found) return found;
  }
  return undefined;
}
