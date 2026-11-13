# ADR 0003: Exponential backoff with full jitter

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

Destinations fail: deploys, overloads, outages. Retrying immediately makes an overloaded destination
worse, and retrying at fixed intervals synchronizes every delivery that failed during the same outage,
so they all hit the destination again at the same instant when it recovers (thundering herd).

## Decision

- Only **retryable** failures are retried: timeout, network error, 5xx, 408 and 429. Other 4xx and
  redirects (never followed) are permanent and go straight to the dead-letter state.
- The wait after attempt _n_ is drawn uniformly from `[0, ceiling(n))`, with
  `ceiling(n) = min(6 h, 30 s × 4^(n-1))`: ceilings of 30 s, 2 min, 8 min, 32 min, ~2 h, 6 h, 6 h.
  A minimum of 1 s avoids instant retries. This is "full jitter" from the AWS Architecture Blog's
  "Exponential Backoff and Jitter".
- A `Retry-After` header (seconds or HTTP date) from the destination wins over our backoff, capped
  at 6 h. Telegram's `retry_after` in the body is honoured the same way.
- After 8 attempts the delivery is `dead`; an admin can replay it with a fresh budget.
- The function is pure (`nextDelayMs(attempt, random)`) with the random source injected, so tests
  are deterministic.

## Consequences

- The expected wait is half the ceiling; in exchange, retries from one outage are spread out as much
  as possible.
- Total retry window before dead-lettering is roughly 15 hours in the worst case, which covers a
  long weekend-night outage of a receiver.
- Alternatives considered: fixed intervals (synchronized retries), "equal jitter"
  (`ceiling/2 + random(0, ceiling/2)`, higher minimum wait, less spread), and decorrelated jitter
  (stateful, harder to reason about in tests).
