import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  createSubscription,
  rotateSecret,
  SubscriptionErrors,
  updateSubscription,
  type SubscriptionDeps,
} from '../../application/subscriptions.js';
import type { Repositories } from '../../application/ports.js';
import { CHANNELS, isValidEventTypePattern, type Subscription } from '../../domain/subscription.js';
import { requireRole } from '../auth.js';
import { HttpProblem } from '../problem.js';

const eventTypes = z
  .array(
    z
      .string()
      .refine(
        isValidEventTypePattern,
        'Use "*", "appointment.*" or an exact type like "appointment.created".',
      ),
  )
  .min(1)
  .max(50);

const subscriptionView = z.object({
  id: z.uuid(),
  name: z.string(),
  channel: z.enum(CHANNELS),
  target: z.string(),
  eventTypes: z.array(z.string()),
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const toView = (subscription: Subscription) => ({
  ...subscription,
  eventTypes: [...subscription.eventTypes],
  createdAt: subscription.createdAt.toISOString(),
  updatedAt: subscription.updatedAt.toISOString(),
});

const idParams = z.object({ id: z.uuid() });

export interface SubscriptionRoutesOptions {
  readonly deps: SubscriptionDeps;
  readonly repositories: Repositories;
}

export const subscriptionRoutes: FastifyPluginAsyncZod<SubscriptionRoutesOptions> = async (
  app,
  { deps, repositories },
) => {
  // preValidation, not preHandler: authorization must run before the body is validated, or an
  // anonymous caller would get a 400 describing the schema instead of a 401.
  app.addHook('preValidation', requireRole('admin'));

  app.post(
    '/subscriptions',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Create a subscription',
        description:
          'For webhooks, the response includes the signing secret. It is shown only this once.',
        body: z.object({
          name: z.string().trim().min(1).max(100),
          channel: z.enum(CHANNELS),
          target: z.string().min(1).max(2000),
          eventTypes,
        }),
        response: { 201: subscriptionView.extend({ secret: z.string().nullable() }) },
      },
    },
    async (request, reply) => {
      const result = await createSubscription(request.body, deps);
      if (!result.ok) throw HttpProblem.fromDomain(result.error);
      const { subscription, secret } = result.value;
      reply.header('Location', `/subscriptions/${subscription.id}`);
      return reply.status(201).send({ ...toView(subscription), secret });
    },
  );

  app.get(
    '/subscriptions',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'List subscriptions (without secrets)',
        response: { 200: z.object({ items: z.array(subscriptionView) }) },
      },
    },
    async () => ({ items: (await repositories.subscriptions.list()).map(toView) }),
  );

  app.get(
    '/subscriptions/:id',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'A subscription (without its secret)',
        params: idParams,
        response: { 200: subscriptionView },
      },
    },
    async (request) => {
      const subscription = await repositories.subscriptions.findById(request.params.id);
      if (!subscription) throw HttpProblem.fromDomain(SubscriptionErrors.notFound());
      return toView(subscription);
    },
  );

  app.patch(
    '/subscriptions/:id',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Activate, deactivate, rename, retarget or change event types',
        params: idParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(100),
            target: z.string().min(1).max(2000),
            eventTypes,
            isActive: z.boolean(),
          })
          .partial()
          .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.'),
        response: { 200: subscriptionView },
      },
    },
    async (request) => {
      const result = await updateSubscription(request.params.id, request.body, deps);
      if (!result.ok) throw HttpProblem.fromDomain(result.error);
      return toView(result.value);
    },
  );

  app.post(
    '/subscriptions/:id/rotate-secret',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Issue a new signing secret',
        description:
          'The previous secret keeps signing for 24 hours, so the receiver can switch without losing events.',
        params: idParams,
        response: {
          200: z.object({ secret: z.string(), previousSecretExpiresAt: z.iso.datetime() }),
        },
      },
    },
    async (request) => {
      const result = await rotateSecret(request.params.id, deps);
      if (!result.ok) throw HttpProblem.fromDomain(result.error);
      return {
        secret: result.value.secret,
        previousSecretExpiresAt: result.value.previousSecretExpiresAt.toISOString(),
      };
    },
  );
};
