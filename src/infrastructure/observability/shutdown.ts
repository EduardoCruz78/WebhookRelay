export interface ShutdownLogger {
  info(object: object, message: string): void;
  error(object: object, message: string): void;
}

/**
 * Graceful shutdown on SIGTERM (what Render, Docker and Kubernetes send before killing a process)
 * and SIGINT (Ctrl+C). Runs the steps in order: stop taking work, finish work in progress, release
 * resources. If they take longer than `timeoutMs`, exits anyway: the platform will SIGKILL soon,
 * and an unfinished delivery is not lost (its job expires and pg-boss runs it again).
 */
export function installShutdown(options: {
  readonly log: ShutdownLogger;
  readonly timeoutMs: number;
  readonly steps: readonly (() => Promise<void>)[];
  readonly exit?: (code: number) => void;
  /** Defaults to SIGTERM and SIGINT; tests pass [] and call the returned function. */
  readonly signals?: readonly NodeJS.Signals[];
}): (signal: NodeJS.Signals) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  let done: Promise<void> = Promise.resolve();

  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (started) return done;
    started = true;
    options.log.info({ signal }, 'shutting down: finishing work in progress');

    const timer = setTimeout(() => {
      options.log.error({ timeoutMs: options.timeoutMs }, 'shutdown timed out; exiting');
      exit(1);
    }, options.timeoutMs);
    timer.unref();

    done = (async () => {
      try {
        for (const step of options.steps) await step();
        clearTimeout(timer);
        options.log.info({}, 'shutdown complete');
        exit(0);
      } catch (error) {
        clearTimeout(timer);
        options.log.error({ err: error }, 'error during shutdown');
        exit(1);
      }
    })();
    return done;
  };

  for (const signal of options.signals ?? ['SIGTERM', 'SIGINT']) {
    process.once(signal, (received: NodeJS.Signals) => void shutdown(received));
  }
  return shutdown;
}
