# ADR 0004: HMAC-SHA256 signatures with a timestamp (Standard Webhooks)

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

A receiver must be able to tell that a request really comes from WebhookRelay, that the body was not
altered, and that it is not an old request being replayed. Options: mutual TLS (heavy for receivers),
a static shared token in a header (proves nothing about the body and is replayable), or an HMAC
signature over the body.

## Decision

Follow the open [Standard Webhooks](https://www.standardwebhooks.com) specification (used by Svix and
close to Stripe's scheme):

- Headers `webhook-id` (the event id, identical on every retry), `webhook-timestamp` (Unix seconds)
  and `webhook-signature` (`v1,<base64>`).
- Signature: `HMAC-SHA256(key, "<id>.<timestamp>.<body>")`, where the secret is `whsec_<base64 key>`
  with 32 random bytes, generated per subscription and shown once.
- The timestamp is inside the signed content: receivers reject anything older than 5 minutes, so a
  captured request cannot be replayed.
- Verification compares in constant time (`timingSafeEqual`), so response timing reveals nothing.
- **Rotation:** the previous secret keeps signing for 24 hours; during that window the header holds
  two signatures and receivers accept either, so they can switch without losing events.

## Consequences

- Receivers can use any Standard Webhooks library in many languages. The implementation is tested
  against the official `standardwebhooks` package in both directions and against the
  specification's published test vector; SchedulingApi's test suite verifies a WebhookRelay
  signature with a C# implementation (contract test).
- Secrets must be stored in a retrievable form to sign (unlike API keys, which are stored as
  hashes). Encrypting the column with an application key is on the roadmap.
- The `v1` prefix leaves room for a future algorithm (for example asymmetric signatures) without
  breaking receivers.
