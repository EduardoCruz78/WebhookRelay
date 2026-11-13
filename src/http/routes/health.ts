import type { FastifyPluginAsync } from 'fastify';

export interface HealthRoutesOptions {
  /** Resolves to true when the database answers. */
  readonly checkDatabase: () => Promise<boolean>;
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness: 200 when the database answers, 503 otherwise',
        security: [],
      },
    },
    async (_request, reply) => {
      const database = await options.checkDatabase().catch(() => false);
      return reply
        .status(database ? 200 : 503)
        .send({ status: database ? 'ok' : 'unavailable', checks: { database } });
    },
  );
};
