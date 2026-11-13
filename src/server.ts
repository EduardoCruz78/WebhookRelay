import { createRuntime } from './composition.js';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';

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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    // Stop accepting requests and finish in-flight ones, then release the queue and the pool.
    app
      .close()
      .then(() => runtime.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'error during shutdown');
          process.exit(1);
        },
      );
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
