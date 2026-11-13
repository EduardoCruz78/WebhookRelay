import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiKeyRepository } from '../application/ports.js';
import { hashApiKey, type ApiKeyRole } from '../domain/api-key.js';
import { sendProblem } from './problem.js';

export interface Principal {
  readonly apiKeyId: string;
  readonly name: string;
  readonly role: ApiKeyRole;
  readonly source: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{1,200})$/;

/**
 * Resolves `Authorization: Bearer <key>` to a principal on every request. Routes then declare who
 * may call them with `requireRole`. The key is looked up by its SHA-256 hash; the raw key is never
 * stored or logged.
 */
export function registerAuthentication(app: FastifyInstance, apiKeys: ApiKeyRepository): void {
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (request) => {
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (!match?.[1]) return;
    const apiKey = await apiKeys.findActiveByHash(hashApiKey(match[1]));
    if (apiKey) {
      request.principal = {
        apiKeyId: apiKey.id,
        name: apiKey.name,
        role: apiKey.role,
        source: apiKey.source,
      };
    }
  });
}

/** preHandler: 401 without a valid key, 403 when the key has another role. */
export function requireRole(...roles: readonly ApiKeyRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.principal) {
      reply.header('WWW-Authenticate', 'Bearer');
      return sendProblem(reply, request, {
        status: 401,
        detail: 'A valid API key is required: Authorization: Bearer <key>.',
        code: 'Auth.Unauthenticated',
      });
    }
    if (!roles.includes(request.principal.role)) {
      return sendProblem(reply, request, {
        status: 403,
        detail: `This operation requires one of the roles: ${roles.join(', ')}.`,
        code: 'Auth.Forbidden',
      });
    }
    return undefined;
  };
}
