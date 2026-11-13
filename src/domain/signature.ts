import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { err, ok, type Result } from './result.js';

/**
 * Webhook signatures (rule D8), compatible with the Standard Webhooks specification
 * (https://www.standardwebhooks.com), the scheme used by Svix and similar to Stripe's:
 *
 *   Webhook-Signature: v1,<base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`))>
 *
 * The timestamp is part of the signed content, so a captured request cannot be replayed later
 * with a fresh timestamp, and the receiver rejects stale ones.
 */
export const SECRET_PREFIX = 'whsec_';
export const SIGNATURE_VERSION = 'v1';
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export interface SigningSecret {
  readonly value: string;
  /** Set on the previous secret after a rotation: it keeps signing until then (24 h grace). */
  readonly expiresAt: Date | null;
}

export function generateSecret(bytes: (size: number) => Buffer = randomBytes): string {
  return SECRET_PREFIX + bytes(32).toString('base64');
}

export function isValidSecret(secret: string): boolean {
  if (!secret.startsWith(SECRET_PREFIX)) return false;
  const encoded = secret.slice(SECRET_PREFIX.length);
  return /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && Buffer.from(encoded, 'base64').length >= 24;
}

function secretKey(secret: string): Buffer {
  if (!isValidSecret(secret)) throw new RangeError('Malformed signing secret');
  return Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
}

export interface SignedContent {
  readonly messageId: string;
  /** Unix time in seconds. */
  readonly timestamp: number;
  /** The exact bytes sent as the request body. */
  readonly body: string;
}

export function sign(secret: string, content: SignedContent): string {
  const mac = createHmac('sha256', secretKey(secret))
    .update(`${content.messageId}.${content.timestamp}.${content.body}`)
    .digest('base64');
  return `${SIGNATURE_VERSION},${mac}`;
}

/** Secrets that may still sign at `now`: the current one plus a rotated one inside its grace period. */
export function activeSecrets(secrets: readonly SigningSecret[], now: Date): string[] {
  return secrets
    .filter((secret) => secret.expiresAt === null || secret.expiresAt.getTime() > now.getTime())
    .map((secret) => secret.value);
}

/** One signature per active secret, space-separated: the receiver accepts the request if any matches. */
export function signatureHeader(secrets: readonly string[], content: SignedContent): string {
  if (secrets.length === 0) throw new RangeError('At least one signing secret is required');
  return secrets.map((secret) => sign(secret, content)).join(' ');
}

export type VerificationError =
  'missing_headers' | 'invalid_timestamp' | 'timestamp_out_of_tolerance' | 'invalid_signature';

export interface VerificationInput {
  readonly secrets: readonly string[];
  readonly messageId: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly body: string;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}

/** What a receiver does. Shipped here for the contract tests and as reference for integrators. */
export function verify(input: VerificationInput): Result<void, VerificationError> {
  const { messageId, timestamp, signature } = input;
  if (!messageId || !timestamp || !signature) return err('missing_headers');

  if (!/^\d+$/.test(timestamp)) return err('invalid_timestamp');
  const seconds = Number(timestamp);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - seconds) > tolerance) return err('timestamp_out_of_tolerance');

  const received = signature
    .split(' ')
    .filter((part) => part.startsWith(`${SIGNATURE_VERSION},`))
    .map((part) => Buffer.from(part.slice(SIGNATURE_VERSION.length + 1)));

  const content = { messageId, timestamp: seconds, body: input.body };
  for (const secret of input.secrets) {
    const expected = Buffer.from(sign(secret, content).slice(SIGNATURE_VERSION.length + 1));
    // Constant-time comparison: an early-exit compare would leak, through response timing,
    // how many leading bytes of a forged signature are right.
    if (
      received.some(
        (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
      )
    ) {
      return ok(undefined);
    }
  }
  return err('invalid_signature');
}
