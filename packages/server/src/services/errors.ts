export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code = 'ERROR', readonly details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'NOT_FOUND');
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg, 'FORBIDDEN');
export const unauthorized = (msg = 'Unauthorized') => new HttpError(401, msg, 'UNAUTHORIZED');
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, 'BAD_REQUEST', details);
export const conflict = (msg: string) => new HttpError(409, msg, 'CONFLICT');
