/**
 * Central API error types.
 *
 * Every user-facing error carries a safe message that is safe to send to the
 * browser. Unknown storage or internal exceptions must never be forwarded;
 * map them through {@link toErrorResponse} to a generic 503 instead.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class BadRequestError extends ApiError {
  constructor(message = "Malformed request") {
    super(400, message);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Authentication required") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/**
 * Unknown storage or internal failure: a generic 503 with a safe message,
 * never the raw Redis exception or connection details.
 */
export const storageFailureMessage = "Service temporarily unavailable, please try again later";

export function storageFailure(): ApiError {
  return new ApiError(503, storageFailureMessage);
}

/**
 * JSON response with Cache-Control: no-store. Personalized game state and
 * error payloads must never be cached by browsers or intermediaries.
 */
export function jsonNoStore(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Maps any thrown value to a safe JSON response. ApiErrors expose their own
 * status and message; anything else (storage failures, bugs, rejected Redis
 * promises) becomes a generic 503 without internals leaking to the client.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonNoStore({ error: error.message }, error.status);
  }
  return jsonNoStore({ error: storageFailureMessage }, 503);
}
