import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { InvalidCursorError, type Repositories, type UnitOfWork } from '../../application/ports.js';
import { DeliveryNotFound, replayDelivery } from '../../application/replay-delivery.js';
import type { Clock } from '../../domain/clock.js';
import { DELIVERY_STATUSES, type Delivery } from '../../domain/delivery.js';
import type { DeliveryAttempt } from '../../domain/delivery-attempt.js';
import { requireRole } from '../auth.js';
import { HttpProblem } from '../problem.js';

const deliveryView = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  subscriptionId: z.uuid(),
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.number().int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const attemptView = z.object({
  attemptNumber: z.number().int(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int(),
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  responseSnippet: z.string().nullable(),
});

const toView = (delivery: Delivery) => ({
  ...delivery,
  nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
  createdAt: delivery.createdAt.toISOString(),
  updatedAt: delivery.updatedAt.toISOString(),
});

const toAttemptView = (attempt: DeliveryAttempt) => ({
  attemptNumber: attempt.attemptNumber,
  startedAt: attempt.startedAt.toISOString(),
  durationMs: attempt.durationMs,
  httpStatus: attempt.httpStatus,
  error: attempt.error,
  responseSnippet: attempt.responseSnippet,
});

const idParams = z.object({ id: z.uuid() });

export interface DeliveryRoutesOptions {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

export const deliveryRoutes: FastifyPluginAsyncZod<DeliveryRoutesOptions> = async (
  app,
  { repositories, unitOfWork, clock },
) => {
  // preValidation, not preHandler: authorization must run before the body is validated, or an
  // anonymous caller would get a 400 describing the schema instead of a 401.
  app.addHook('preValidation', requireRole('admin'));

  app.get(
    '/deliveries',
    {
      schema: {
        tags: ['deliveries'],
        summary: 'List deliveries, newest first',
        description:
          'Filter with status=dead to see the dead-letter queue. Paginate with `cursor`.',
        querystring: z.object({
          status: z.enum(DELIVERY_STATUSES).optional(),
          subscriptionId: z.uuid().optional(),
          eventId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({ items: z.array(deliveryView), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request) => {
      try {
        const page = await repositories.deliveries.list(request.query);
        return { items: page.items.map(toView), nextCursor: page.nextCursor };
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          throw new HttpProblem(400, 'The cursor is not valid.', 'Delivery.InvalidCursor');
        }
        throw error;
      }
    },
  );

  app.get(
    '/deliveries/:id',
    {
      schema: {
        tags: ['deliveries'],
        summary: 'A delivery',
        params: idParams,
        response: { 200: deliveryView },
      },
    },
    async (request) => {
      const delivery = await repositories.deliveries.findById(request.params.id);
      if (!delivery) throw HttpProblem.fromDomain(DeliveryNotFound);
      return toView(delivery);
    },
  );

  app.get(
    '/deliveries/:id/attempts',
    {
      schema: {
        tags: ['deliveries'],
        summary: 'Attempt history of a delivery, oldest first',
        params: idParams,
        response: { 200: z.object({ items: z.array(attemptView) }) },
      },
    },
    async (request) => {
      const delivery = await repositories.deliveries.findById(request.params.id);
      if (!delivery) throw HttpProblem.fromDomain(DeliveryNotFound);
      const attempts = await repositories.attempts.listByDelivery(delivery.id);
      return { items: attempts.map(toAttemptView) };
    },
  );

  app.post(
    '/deliveries/:id/replay',
    {
      schema: {
        tags: ['deliveries'],
        summary: 'Send a dead delivery again',
        description: 'Only deliveries in the dead state; the retry budget starts over (rule D6).',
        params: idParams,
        response: { 202: deliveryView },
      },
    },
    async (request, reply) => {
      const result = await replayDelivery(request.params.id, { unitOfWork, clock });
      if (!result.ok) throw HttpProblem.fromDomain(result.error);
      return reply.status(202).send(toView(result.value));
    },
  );
};
