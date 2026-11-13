import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

import type { DomainError, ErrorType } from '../domain/result.js';

/**
 * Errors follow RFC 9457 (Problem Details for HTTP APIs), like SchedulingApi:
 * `application/problem+json` with type, title, status, detail and, for us, a stable `code`.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly code?: string;
  readonly instance?: string;
  /** Field-level validation messages, keyed by JSON path (`data.startsAt`). */
  readonly errors?: Record<string, string[]>;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const STATUS_BY_ERROR_TYPE: Record<ErrorType, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  business_rule: 422,
};

/** Thrown from handlers to answer with a problem response. */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
    readonly problemCode?: string,
  ) {
    super(detail ?? TITLES[status] ?? `HTTP ${status}`);
  }

  static fromDomain(error: DomainError): HttpProblem {
    return new HttpProblem(STATUS_BY_ERROR_TYPE[error.type], error.message, error.code);
  }
}

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  problem: Omit<ProblemDetails, 'type' | 'title' | 'instance'> & { title?: string },
): FastifyReply {
  const body: ProblemDetails = {
    type: 'about:blank',
    title: problem.title ?? TITLES[problem.status] ?? 'Error',
    instance: request.url,
    ...problem,
  };
  return reply.status(problem.status).type('application/problem+json').send(body);
}

/** "/body/data/startsAt" becomes "data.startsAt"; the request part (body, query, params) is implied. */
function fieldPath(instancePath: string): string {
  const segments = instancePath.split('/').filter(Boolean);
  const field = segments.slice(1).join('.');
  if (field !== '') return field;
  return segments[0] ?? 'request';
}

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (hasZodFastifySchemaValidationErrors(error)) {
    const errors: Record<string, string[]> = {};
    for (const issue of error.validation) {
      const path = fieldPath(issue.instancePath);
      (errors[path] ??= []).push(issue.message ?? 'Invalid value');
    }
    return sendProblem(reply, request, {
      status: 400,
      detail: 'The request is invalid.',
      code: 'Request.Invalid',
      errors,
    });
  }

  if (error instanceof HttpProblem) {
    return sendProblem(reply, request, {
      status: error.status,
      ...(error.detail !== undefined && { detail: error.detail }),
      ...(error.problemCode !== undefined && { code: error.problemCode }),
    });
  }

  // Fastify's own client errors: malformed JSON (400), body too large (413), wrong content type (415).
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    return sendProblem(reply, request, { status, detail: error.message, code: error.code });
  }

  request.log.error({ err: error }, 'unhandled error');
  return sendProblem(reply, request, {
    status: 500,
    detail: 'An unexpected error occurred.',
    code: 'Server.Unexpected',
  });
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return sendProblem(reply, request, {
    status: 404,
    detail: `Route ${request.method} ${request.url} does not exist.`,
    code: 'Route.NotFound',
  });
}
