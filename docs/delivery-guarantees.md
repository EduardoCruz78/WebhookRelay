# Delivery guarantees

WebhookRelay delivers every event **at least once** to every interested subscription. This page
lists the rules that make that true and what an integrator has to do on their side.

## Rules

| #   | Rule                                                                                                                                                                       | Where                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| D1  | A repeated event (same `source` + `idempotencyKey`) is accepted with **200** and creates nothing new.                                                                      | ingestion (M3)                                        |
| D2  | Each event creates one delivery per **active** subscription whose filter matches the event type (fan-out). A delivery is unique per (event, subscription).                 | `isInterestedIn` in `src/domain/subscription.ts`      |
| D3  | Success means an HTTP **2xx** within the timeout (10 s). Anything else is a failure.                                                                                       | `classifyOutcome` in `src/domain/attempt-outcome.ts`  |
| D4  | **Retryable** failures (timeout, network error, 5xx, 408, 429) are retried with exponential backoff and full jitter. Ceilings: 30 s, 2 min, 8 min, 32 min, ~2 h, 6 h, 6 h. | `nextDelayMs` in `src/domain/retry-policy.ts`         |
| D5  | **Permanent** failures (any other 4xx, and 3xx because redirects are never followed) go straight to `dead`, without retrying.                                              | `classifyOutcome`                                     |
| D6  | After **8 attempts** a delivery goes to `dead` (dead-letter). It can be replayed manually (`POST /deliveries/{id}/replay`) with a fresh retry budget.                      | `recordAttempt`, `replay` in `src/domain/delivery.ts` |
| D7  | On `Retry-After` (seconds or HTTP date) the destination's delay wins over our backoff, capped at 6 h.                                                                      | `parseRetryAfter`, `recordAttempt`                    |
| D8  | Every webhook carries `Webhook-Id`, `Webhook-Timestamp` and `Webhook-Signature` (HMAC-SHA256 of `id.timestamp.body`), following the Standard Webhooks spec.                | `src/domain/signature.ts`                             |
| D9  | Guarantee: **at least once**. The receiver must deduplicate by `Webhook-Id`.                                                                                               | integrator                                            |
| D10 | Order is **not** guaranteed across events. The receiver compares `occurredAt`.                                                                                             | integrator                                            |

## Delivery states

```
pending ──2xx──────────────► succeeded
   │
   ├──retryable──► failed ──(retry at nextAttemptAt)──► ... ──2xx──► succeeded
   │                  │
   │                  └──8th attempt fails──► dead
   │
   └──permanent──────────────────────────────────────► dead ──replay──► pending
```

## Why "at least once" and not "exactly once"

The sender can never tell "the request never arrived" apart from "it arrived, was processed, and
the response was lost". Retrying covers the first case and duplicates the second. Not retrying
loses events. So WebhookRelay retries, and the duplicate is made harmless on the receiving side:
the `Webhook-Id` stays the same across retries, so the receiver stores the ids it has processed and
ignores repeats. At-least-once delivery plus an idempotent receiver gives the effect of
exactly-once processing.

## Why order is not guaranteed

Events for different subscriptions and retries are processed in parallel. If `appointment.created`
fails once and is retried in 30 s, while `appointment.cancelled` succeeds immediately, the receiver
sees the cancellation first. Forcing a global order would mean one slow destination blocks every
event behind it (head-of-line blocking). Instead, each message carries `occurredAt`: a receiver
that keeps state should ignore an event older than what it already applied.
