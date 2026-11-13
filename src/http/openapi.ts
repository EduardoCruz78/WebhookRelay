import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

/**
 * OpenAPI generated from the Zod schemas that already validate every route, so the docs cannot
 * drift from the code. Served as JSON at /openapi.json and rendered by Scalar at /docs.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'WebhookRelay',
        version: '0.1.0',
        description:
          'Reliable event delivery: at-least-once delivery with retries and a dead-letter queue, ' +
          'idempotent ingestion and HMAC-signed webhooks (Standard Webhooks). ' +
          'Authenticate with `Authorization: Bearer <api key>`: source keys publish events, ' +
          'admin keys manage subscriptions and deliveries.',
      },
      components: {
        securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'wr_...' } },
      },
      security: [{ apiKey: [] }],
      tags: [
        { name: 'events', description: 'Publish events (source keys)' },
        { name: 'subscriptions', description: 'Who receives what (admin keys)' },
        { name: 'deliveries', description: 'Delivery status, attempts and replay (admin keys)' },
        { name: 'health', description: 'Liveness and readiness' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  // Scalar also serves the document at /docs/openapi.json; this is the conventional location.
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: { title: 'WebhookRelay API' },
  });
}
