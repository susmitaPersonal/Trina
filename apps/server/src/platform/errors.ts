import type { ErrorCode, ProblemDetails } from '@trina/contracts';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from './logger';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, errors?: { path: string; message: string }[]) => new HttpError(400, 'VALIDATION_FAILED', msg, errors);
export const unauthorized = (msg = 'Authentication required', code: ErrorCode = 'UNAUTHENTICATED') => new HttpError(401, code, msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: ErrorCode, msg: string) => new HttpError(409, code, msg);

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function problem(status: number, code: ErrorCode, detail?: string, errors?: ProblemDetails['errors']): ProblemDetails {
  return {
    type: `https://trina.app/problems/${code.toLowerCase().replace(/_/g, '-')}`,
    title: TITLES[status] ?? 'Error',
    status,
    code,
    ...(detail ? { detail } : {}),
    ...(errors?.length ? { errors } : {}),
  };
}

export function zodToErrors(e: ZodError) {
  return e.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let body: ProblemDetails;
    if (err instanceof HttpError) body = problem(err.status, err.code, err.message, err.errors);
    else if (err instanceof ZodError) body = problem(400, 'VALIDATION_FAILED', 'Invalid request', zodToErrors(err));
    else if (err?.type === 'entity.too.large') body = problem(413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
    else if (err?.type === 'entity.parse.failed') body = problem(400, 'VALIDATION_FAILED', 'Malformed JSON');
    else {
      logger.error({ err: { message: err?.message, stack: err?.stack }, reqId: req.headers['x-request-id'] }, 'unhandled error');
      body = problem(500, 'INTERNAL', 'Something went wrong');
    }
    res.status(body.status).type('application/problem+json').json(body);
  };
}
