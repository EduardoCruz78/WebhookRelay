/** History: one row per attempt, kept even after the delivery succeeds or dies. */
export interface DeliveryAttempt {
  readonly id: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly httpStatus: number | null;
  readonly error: string | null;
  /** First bytes of the response body, for debugging a failing destination. */
  readonly responseSnippet: string | null;
}

export const RESPONSE_SNIPPET_MAX_BYTES = 1024;

/** Cuts text to at most `maxBytes` of UTF-8 without splitting a multi-byte character. */
export function truncateUtf8(text: string, maxBytes: number = RESPONSE_SNIPPET_MAX_BYTES): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // UTF-8 continuation bytes look like 10xxxxxx; back off until a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--;
  return bytes.subarray(0, end).toString('utf8');
}
