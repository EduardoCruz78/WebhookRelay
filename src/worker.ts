import { pino } from 'pino';

import { createRuntime } from './composition.js';
import { loadConfig } from './config.js';

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
log.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down: finishing deliveries in progress');
    runtime.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      },
    );
  });
}
