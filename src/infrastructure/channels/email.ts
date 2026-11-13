import { performance } from 'node:perf_hooks';

import nodemailer, { type Transporter } from 'nodemailer';

import type { ChannelResult, DeliveryChannel, OutgoingMessage } from '../../application/ports.js';
import type { AttemptOutcome } from '../../domain/attempt-outcome.js';
import { toNotification } from '../../domain/notification.js';

export interface EmailChannelOptions {
  /**
   * smtp://mailpit:1025 locally; smtps://resend:<api key>@smtp.resend.com:465 for Resend.
   * Any SMTP provider works, which keeps the code free of a vendor SDK.
   */
  readonly smtpUrl: string;
  readonly from: string;
  readonly timeoutMs: number;
}

/** Sends the event as a plain-text e-mail to the subscription's address. */
export class EmailChannel implements DeliveryChannel {
  private readonly transporter: Transporter;

  constructor(private readonly options: EmailChannelOptions) {
    const url = new URL(options.smtpUrl);
    const secure = url.protocol === 'smtps:';
    this.transporter = nodemailer.createTransport({
      host: url.hostname,
      port: url.port ? Number(url.port) : secure ? 465 : 587,
      secure,
      ...(url.username && {
        auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
      }),
      connectionTimeout: options.timeoutMs,
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
    });
  }

  async send({ event, subscription }: OutgoingMessage): Promise<ChannelResult> {
    const { subject, text } = toNotification(event);
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const info = (await this.transporter.sendMail({
        from: this.options.from,
        to: subscription.target,
        subject,
        text,
        // Same id as the webhook header, so a mailbox rule can deduplicate retries too.
        headers: { 'X-Webhook-Id': event.id },
      })) as { response?: string };
      const detail = info.response ?? 'accepted';
      return {
        outcome: { kind: 'accepted', detail },
        responseSnippet: detail,
        durationMs: elapsed(),
      };
    } catch (error) {
      return {
        outcome: smtpFailure(error, this.options.timeoutMs),
        responseSnippet: null,
        durationMs: elapsed(),
      };
    }
  }

  close(): void {
    this.transporter.close();
  }
}

/**
 * SMTP replies: 4xx is a temporary refusal (mailbox busy, greylisting) and is retried; 5xx is
 * permanent (no such mailbox, policy rejection). Connection problems are retried like HTTP ones.
 */
export function smtpFailure(error: unknown, timeoutMs: number): AttemptOutcome {
  const { code, responseCode, response, message } = (error ?? {}) as {
    code?: string;
    responseCode?: number;
    response?: string;
    message?: string;
  };
  const reason = (response ?? message ?? String(error)).trim();

  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
    return { kind: 'rejected', retryable: true, reason };
  }
  if (responseCode !== undefined && responseCode >= 500) {
    return { kind: 'rejected', retryable: false, reason };
  }
  if (code === 'ETIMEDOUT') return { kind: 'timeout', timeoutMs };
  // An invalid recipient address will never become valid by retrying.
  if (code === 'EENVELOPE') return { kind: 'rejected', retryable: false, reason };
  return { kind: 'network_error', message: code ? `${code}: ${reason}` : reason };
}
