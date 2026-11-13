import { createRuntime } from './composition.js';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { installShutdown } from './infrastructure/observability/shutdown.js';

const config = loadConfig();
const runtime = await createRuntime(config, (error) => {
  app.log.error({ err: error }, 'queue error');
});
const app = await buildApp(config, runtime.app);

if (config.RUN_WORKER) {
  // Free-tier demo: one process serves HTTP and delivers. Production runs `node dist/worker.js` apart.
  await runtime.startWorker();
  app.log.info('delivery worker running in the web process');
}

installShutdown({
  log: app.log,
  timeoutMs: config.DELIVERY_TIMEOUT_MS + 15_000,
  steps: [
    // 1. Stop accepting connections and let in-flight requests finish.
    () => app.close(),
    // 2. Stop the worker (if any) after its deliveries in progress, then close the pool.
    () => runtime.close(),
  ],
});

await app.listen({ host: config.HOST, port: config.PORT });
