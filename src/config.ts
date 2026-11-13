import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/**
 * Environment configuration, validated once at startup.
 * A missing or malformed variable stops the process before it accepts any traffic.
 */
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Demo convenience: apply migrations at startup. Production runs them as a separate step. */
  MIGRATE_ON_START: booleanString,
  /** Free-tier demo: run the delivery worker inside the web process instead of a separate one. */
  RUN_WORKER: booleanString,
  /** D3: a destination has this long to answer with a 2xx. */
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  /** Deliveries one worker process runs at the same time. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
