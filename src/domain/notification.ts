import type { Event } from './event.js';

/** Telegram rejects messages longer than 4096 characters. */
export const TELEGRAM_MAX_LENGTH = 4096;

export interface Notification {
  readonly subject: string;
  readonly text: string;
}

/**
 * The human-readable form of an event, shared by the e-mail and Telegram channels. Webhooks get
 * the JSON contract instead; people get a short summary followed by the payload.
 */
export function toNotification(event: Event): Notification {
  const subject = `[WebhookRelay] ${event.type} from ${event.source}`;
  const text = [
    `Event: ${event.type}`,
    `Source: ${event.source}`,
    `Occurred at: ${event.occurredAt.toISOString()}`,
    `Event id: ${event.id}`,
    '',
    JSON.stringify(event.payload, null, 2),
  ].join('\n');
  return { subject, text };
}

/** Cuts text to `max` characters, marking the cut, without splitting a surrogate pair (emoji). */
export function truncateText(text: string, max: number): string {
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  const marker = '\n…(truncated)';
  return characters.slice(0, max - Array.from(marker).length).join('') + marker;
}
