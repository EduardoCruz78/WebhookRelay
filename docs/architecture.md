# Architecture

## Processes

One Docker image, two processes:

- **server** (`node dist/server.js`): Fastify HTTP API. Ingests events, manages subscriptions and
  deliveries, serves `/health`, `/metrics`, `/openapi.json` and `/docs`.
- **worker** (`node dist/worker.js`): consumes the pg-boss queue, delivers, records attempts and
  schedules retries. Serves `/health` and `/metrics` on its own port. Scale it horizontally: pg-boss
  hands each job to one worker (`FOR UPDATE SKIP LOCKED`).

On the free demo host both run in one process (`RUN_WORKER=true`).

## Layers

```
src/
├── domain/          pure rules: backoff, outcome classification, signatures, delivery state machine,
│                    target validation (SSRF), network policy. No I/O, no frameworks.
├── application/     use cases (ingestEvent, deliver, replayDelivery, subscriptions) and ports
│                    (repositories, unit of work, queue, channels).
├── infrastructure/  Drizzle + PostgreSQL, pg-boss, channels (webhook, e-mail, Telegram),
│                    SSRF-safe HTTP agent, Prometheus metrics, graceful shutdown.
├── http/            Fastify routes, Zod schemas, API key auth, RFC 9457 problem details, OpenAPI.
├── composition.ts   the only place that wires implementations to ports.
├── server.ts        HTTP process.
└── worker.ts        worker process.
```

ESLint enforces the dependency rule: `domain` imports nothing from the outer layers or I/O
libraries, and `application` never imports `infrastructure` or `http`.

## From booking to webhook

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant API as SchedulingApi
    participant SDB as SchedulingApi DB
    participant Relay as WebhookRelay API
    participant RDB as WebhookRelay DB (+ pg-boss)
    participant Worker as WebhookRelay worker
    participant Dest as Receiver

    Customer->>API: POST /api/appointments
    API->>SDB: BEGIN; insert appointment + outbox row; COMMIT
    API-->>Customer: 201 Created
    loop every 5 s (OutboxDispatcher)
        API->>SDB: SELECT pending ... FOR UPDATE SKIP LOCKED
        API->>Relay: POST /events (id = outbox id)
        Relay->>RDB: BEGIN; insert event (ON CONFLICT DO NOTHING),<br/>deliveries, pg-boss jobs; COMMIT
        Relay-->>API: 202 (new) or 200 (duplicate)
        API->>SDB: processed_at = now
    end
    Worker->>RDB: fetch job (SKIP LOCKED)
    Worker->>Dest: POST signed webhook (10 s timeout)
    alt 2xx
        Worker->>RDB: attempt + succeeded
    else timeout, network, 5xx, 408, 429
        Worker->>RDB: attempt + failed + new job (startAfter = backoff)
    else other 4xx, redirect, blocked target
        Worker->>RDB: attempt + dead
    end
```

## Data

| Table                  | Purpose                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `events`               | What happened. Unique `(source, idempotency_key)` enforces rule D1.                |
| `subscriptions`        | Who receives what. Partial GIN index on `event_types` for active ones.             |
| `subscription_secrets` | Signing secrets; the previous one expires 24 h after a rotation.                   |
| `deliveries`           | One per (event, subscription), unique. Status, attempts, next attempt, last error. |
| `delivery_attempts`    | History: status code, duration, error, first 1 KB of the response.                 |
| `api_keys`             | SHA-256 of each key, role (`source` or `admin`) and source name.                   |
| `pgboss.*`             | The job queue, in the same database.                                               |

## Security

- API keys hashed with SHA-256 (256-bit random keys need no slow hash); `Authorization` redacted
  from logs; authorization runs before body validation.
- SSRF protection in three layers: target validation, DNS check at registration, and an HTTP agent
  whose DNS lookup refuses non-public addresses on every connection (defeats DNS rebinding).
  Redirects are never followed.
- Webhook signatures per [ADR 0004](adr/0004-hmac-signature-with-timestamp.md).
- Telegram bot token scrubbed from anything stored; secrets only from environment variables.

## Observability

- Structured JSON logs (pino) with event and delivery ids.
- Prometheus metrics: `deliveries_total{channel,status}`, `delivery_duration_seconds`,
  `queue_depth{state}`, `events_received_total{source,duplicate}`,
  `http_request_duration_seconds{method,route,status_code}` and Node process metrics.
- Suggested alerts: failure ratio above 20 % for 10 min; `queue_depth{state="created"}` growing for
  15 min; any new `dead` delivery; p95 delivery duration above 5 s; `/health` failing.
