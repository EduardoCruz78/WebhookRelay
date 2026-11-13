import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { ingestEvent, type IngestEventDeps } from '../../application/ingest-event.js';
import type { Repositories } from '../../application/ports.js';
import type { Delivery } from '../../domain/delivery.js';
import { isValidEventType, type Event } from '../../domain/event.js';
import { requireRole } from '../auth.js';
import { HttpProblem } from '../problem.js';

const ingestBody = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Event id in the source system; repeated ids are ignored (idempotency key).'),
  type: z
    .string()
    .refine(isValidEventType, 'Must look like "appointment.created": lowercase, dot-separated.'),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.record(z.string(), z.json()),
});

const eventSummary = z.object({
  id: z.uuid(),
  source: z.string(),
  type: z.string(),
  externalId: z.string(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
});

const ingestResponse = eventSummary.extend({
  duplicate: z.boolean(),
  deliveryCount: z.number().int().optional(),
});

const deliverySummary = z.object({
  id: z.uuid(),
  subscriptionId: z.uuid(),
  status: z.enum(['pending', 'failed', 'succeeded', 'dead']),
  attempts: z.number().int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
});

const eventDetail = eventSummary.extend({
  data: z.record(z.string(), z.json()),
  deliveries: z.array(deliverySummary),
});

const toSummary = (event: Event) => ({
  id: event.id,
  source: event.source,
  type: event.type,
  externalId: event.idempotencyKey,
  occurredAt: event.occurredAt.toISOString(),
  receivedAt: event.receivedAt.toISOString(),
});

const toDeliverySummary = (delivery: Delivery) => ({
  id: delivery.id,
  subscriptionId: delivery.subscriptionId,
  status: delivery.status,
  attempts: delivery.attempts,
  nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
  lastError: delivery.lastError,
});

export interface EventRoutesOptions {
  readonly ingest: IngestEventDeps;
  readonly repositories: Repositories;
}

export const eventRoutes: FastifyPluginAsyncZod<EventRoutesOptions> = async (app, options) => {
  app.post(
    '/events',
    {
      preHandler: requireRole('source'),
      bodyLimit: 256 * 1024,
      schema: {
        tags: ['events'],
        summary: 'Publish an event',
        description:
          '202 when the event is new and has been fanned out; 200 when the same id was already received (rule D1).',
        body: ingestBody,
        response: { 200: ingestResponse, 202: ingestResponse },
      },
    },
    async (request, reply) => {
      const source = request.principal?.source;
      if (!source) throw new HttpProblem(403, 'This API key cannot publish events.');

      const result = await ingestEvent(
        {
          source,
          externalId: request.body.id,
          type: request.body.type,
          occurredAt: new Date(request.body.occurredAt),
          data: request.body.data,
        },
        options.ingest,
      );

      reply.header('Location', `/events/${result.event.id}`);
      if (result.status === 'duplicate') {
        return reply.status(200).send({ ...toSummary(result.event), duplicate: true });
      }
      return reply.status(202).send({
        ...toSummary(result.event),
        duplicate: false,
        deliveryCount: result.deliveryCount,
      });
    },
  );

  app.get(
    '/events/:id',
    {
      preHandler: requireRole('admin', 'source'),
      schema: {
        tags: ['events'],
        summary: 'An event and its deliveries',
        params: z.object({ id: z.uuid() }),
        response: { 200: eventDetail },
      },
    },
    async (request) => {
      const event = await options.repositories.events.findById(request.params.id);
      // A source key only sees its own events; anything else looks exactly like a missing event.
      const principal = request.principal;
      const visible = event && (principal?.role === 'admin' || principal?.source === event.source);
      if (!visible) throw new HttpProblem(404, 'Event not found.', 'Event.NotFound');

      const deliveries = await options.repositories.deliveries.list({
        eventId: event.id,
        limit: 100,
      });
      return {
        ...toSummary(event),
        data: event.payload,
        deliveries: deliveries.items.map(toDeliverySummary),
      };
    },
  );
};
