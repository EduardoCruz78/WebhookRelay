import type { FastifyPluginAsync } from 'fastify';

import { bearerMatches, type Metrics } from '../../infrastructure/observability/metrics.js';
import { sendProblem } from '../problem.js';

export interface MetricsRoutesOptions {
  readonly metrics: Metrics;
  /** Optional bearer token; without it the endpoint is open (fine on a private network). */
  readonly token?: string | undefined;
}

/** Prometheus scrape endpoint, in the text exposition format. */
export const metricsRoutes: FastifyPluginAsync<MetricsRoutesOptions> = async (app, options) => {
  app.get('/metrics', { schema: { hide: true } }, async (request, reply) => {
    if (options.token && !bearerMatches(request.headers.authorization, options.token)) {
      reply.header('WWW-Authenticate', 'Bearer');
      return sendProblem(reply, request, {
        status: 401,
        detail: 'A metrics token is required.',
        code: 'Metrics.Unauthenticated',
      });
    }
    return reply
      .type(options.metrics.registry.contentType)
      .send(await options.metrics.registry.metrics());
  });
};
