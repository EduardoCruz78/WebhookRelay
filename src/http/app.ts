import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { HostChecker, Repositories, UnitOfWork } from '../application/ports.js';
import type { Config } from '../config.js';
import type { Clock } from '../domain/clock.js';
import type { TargetPolicy } from '../domain/subscription.js';
import { registerAuthentication } from './auth.js';
import { errorHandler, notFoundHandler } from './problem.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { eventRoutes } from './routes/events.js';
import { healthRoutes } from './routes/health.js';
import { subscriptionRoutes } from './routes/subscriptions.js';

export interface AppDependencies {
  readonly clock: Clock;
  readonly newId: () => string;
  readonly unitOfWork: UnitOfWork;
  readonly repositories: Repositories;
  readonly checkDatabase: () => Promise<boolean>;
  readonly targetPolicy: TargetPolicy;
  readonly checkHost: HostChecker;
}

export async function buildApp(
  config: Pick<Config, 'LOG_LEVEL'>,
  deps: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log credentials: API keys arrive in the Authorization header.
      redact: ['req.headers.authorization'],
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  registerAuthentication(app, deps.repositories.apiKeys);

  await app.register(healthRoutes, { checkDatabase: deps.checkDatabase });
  await app.register(eventRoutes, {
    ingest: { unitOfWork: deps.unitOfWork, clock: deps.clock, newId: deps.newId },
    repositories: deps.repositories,
  });
  await app.register(subscriptionRoutes, {
    deps: {
      unitOfWork: deps.unitOfWork,
      clock: deps.clock,
      newId: deps.newId,
      targetPolicy: deps.targetPolicy,
      checkHost: deps.checkHost,
    },
    repositories: deps.repositories,
  });
  await app.register(deliveryRoutes, {
    repositories: deps.repositories,
    unitOfWork: deps.unitOfWork,
    clock: deps.clock,
  });

  return app;
}
