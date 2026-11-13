# ADR 0001: Queue on PostgreSQL with pg-boss, not Redis or a broker

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

Ingesting an event means three writes: the event, one delivery per interested subscription, and one
job per delivery for the worker. If the job lives in another system (Redis, RabbitMQ), those writes
are a dual write: the process can crash after committing the event and before enqueuing, leaving
deliveries that are never attempted, or enqueue jobs for an event whose transaction rolled back.

The demo also runs on free tiers (Render web service + Neon PostgreSQL), where extra infrastructure
is not available.

## Decision

Use [pg-boss](https://github.com/timgit/pg-boss): a job queue stored in PostgreSQL tables (schema
`pgboss`) in the same database as the data.

- Jobs are inserted through the ingestion transaction's own connection (`boss.insert(..., { db })`),
  so the event, its deliveries and its jobs commit or roll back together.
- Workers fetch jobs with `SELECT ... FOR UPDATE SKIP LOCKED`: any number of worker processes poll
  the same queue, each job goes to exactly one of them, and nobody waits on another's locks.
- Retry timing is decided by our domain (backoff, `Retry-After`, dead-letter); a retry is a new job
  with `startAfter`. pg-boss's own retry only covers a worker that crashed mid-job (job expiry).

## Consequences

- One system to run, back up and monitor. Transactional enqueueing for free.
- Throughput is bounded by PostgreSQL: comfortably thousands of jobs per second, far beyond a
  webhook relay's needs at this scale, but not Kafka-level volumes.
- Polling adds latency (seconds); pg-boss can use LISTEN/NOTIFY to reduce it.

## When to switch

| Need                                                                 | Better fit                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Very high throughput, sub-millisecond latency, already running Redis | Redis + BullMQ (lose the transactional enqueue; add an outbox) |
| Many independent consumers, routing, fan-out to other services       | RabbitMQ                                                       |
| Replayable event log, retention, stream processing, very high volume | Kafka                                                          |
