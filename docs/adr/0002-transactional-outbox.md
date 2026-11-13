# ADR 0002: Transactional Outbox on the producer side

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

SchedulingApi must tell WebhookRelay when an appointment is booked or cancelled. Calling
`POST /events` from the request handler is a dual write between SchedulingApi's database and
WebhookRelay:

| Order                       | Failure                                  | Result                                       |
| --------------------------- | ---------------------------------------- | -------------------------------------------- |
| Commit, then call the relay | Relay down, timeout, crash after commit  | Event lost                                   |
| Call the relay, then commit | Commit fails (slot taken, database down) | Event for an appointment that does not exist |

## Decision

SchedulingApi implements the Transactional Outbox (its ADR 0005):

1. The `Appointment` aggregate raises domain events when its state really changes.
2. The unit of work stores them in `outbox_messages` in the same `SaveChanges` transaction as the
   appointment.
3. A background dispatcher claims pending rows with `FOR UPDATE SKIP LOCKED`, publishes them to
   `POST /events`, and marks them processed. While the relay is down, rows wait and polling backs off.

WebhookRelay's part of the contract is **idempotent ingestion** (rule D1): the outbox message id is
the event id, and a repeated `(source, id)` is answered `200` without creating anything. This
absorbs the re-send that happens when the relay accepted a message but the dispatcher crashed before
marking it processed.

## Consequences

- No event is lost and no event is published for a rolled-back change.
- Publication is at least once, and WebhookRelay makes it effectively once.
- Delay of a few seconds (the poll interval) between the booking and the event.
- Verified end to end in CI (`e2e/`): a booking on SchedulingApi reaches a webhook receiver, signed.
