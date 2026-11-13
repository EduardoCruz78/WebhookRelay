import { createServer } from 'node:http';

import { pino } from 'pino';

import { createRuntime } from './composition.js';
import { loadConfig } from './config.js';
import { bearerMatches } from './infrastructure/observability/metrics.js';
import { installShutdown } from './infrastructure/observability/shutdown.js';

/** The delivery worker: consumes the queue, sends webhooks, records attempts and schedules retries. */
const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { process: 'worker' } });

const runtime = await createRuntime(config, (error) => {
  log.error({ err: error }, 'queue error');
});

await runtime.startWorker((outcome) => {
  if (outcome.kind === 'attempted') {
    log.info(
      {
        deliveryId: outcome.delivery.id,
        eventId: outcome.delivery.eventId,
        status: outcome.delivery.status,
        attempt: outcome.delivery.attempts,
        durationMs: outcome.result.durationMs,
      },
      'delivery attempted',
    );
  } else if (outcome.kind === 'abandoned') {
    log.warn(
      { deliveryId: outcome.delivery.id, reason: outcome.delivery.lastError },
      'delivery abandoned',
    );
  }
});

// The worker has no API, but Prometheus still needs to scrape it and the platform to probe it.
const probe = createServer((request, response) => {
  if (request.url === '/metrics') {
    if (
      config.METRICS_TOKEN &&
      !bearerMatches(request.headers.authorization, config.METRICS_TOKEN)
    ) {
      response.writeHead(401).end();
      return;
    }
    runtime.metrics.registry.metrics().then(
      (body) =>
        response.writeHead(200, { 'content-type': runtime.metrics.registry.contentType }).end(body),
      () => response.writeHead(500).end(),
    );
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  response.writeHead(404).end();
});
probe.listen(config.WORKER_METRICS_PORT, config.HOST);
log.info(
  { concurrency: config.WORKER_CONCURRENCY, metricsPort: config.WORKER_METRICS_PORT },
  'worker started',
);

installShutdown({
  log,
  timeoutMs: config.DELIVERY_TIMEOUT_MS + 15_000,
  steps: [
    () => runtime.close(),
    () =>
      new Promise<void>((resolve) => {
        probe.close(() => {
          resolve();
        });
      }),
  ],
});
