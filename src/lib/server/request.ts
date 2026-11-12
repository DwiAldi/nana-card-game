import { ApiError, BadRequestError, ForbiddenError } from "./errors";
import { isProduction, type ServerConfig } from "./session";
import { MAX_BODY_BYTES } from "./validation";

/**
 * Request-level hardening shared by mutation routes.
 *
 * Security note: forwarded headers such as X-Forwarded-For, X-Forwarded-Host
 * and Forwarded are attacker-controlled and are never consulted here. The
 * origin decision relies only on the Origin header and fetch metadata the
 * browser itself sets.
 */

const JSON_CONTENT_TYPE_PREFIX = "application/json";

/**
 * Reads and parses a JSON request body.
 *
 * The body is consumed through a byte-counting reader so the 8 KiB limit
 * holds even when Content-Length is absent or lying. Content type and JSON
 * syntax are validated before the caller touches any game state.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  if (!contentType || !contentType.trim().toLowerCase().startsWith(JSON_CONTENT_TYPE_PREFIX)) {
    throw new BadRequestError("Request body must be application/json");
  }

  if (!request.body) {
    throw new BadRequestError("Request body is required");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        throw new BadRequestError(`Request body must be at most ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
  return parsed;
}

/**
 * Verifies that a mutation request comes from the configured origin.
 *
 * Production: the Origin header is mandatory and must equal APP_ORIGIN
 * exactly; a missing or foreign origin is rejected. Cross-site and
 * same-site fetch metadata (Sec-Fetch-Site) is rejected outright.
 *
 * Development/test: when APP_ORIGIN is not configured the dev server port
 * differs from any public origin, so any present Origin header is accepted.
 * A missing Origin is still rejected in every environment, and once
 * APP_ORIGIN is configured it is enforced exactly, as in production.
 */
export function checkMutationOrigin(request: Request, config: ServerConfig): void {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site" || secFetchSite === "same-site") {
    throw new ForbiddenError("Cross-site requests are not allowed");
  }

  const origin = request.headers.get("origin");
  if (origin == null || origin.trim().length === 0) {
    throw new ForbiddenError("Missing Origin header");
  }

  const expectedOrigin = config.appOrigin;
  if (expectedOrigin) {
    if (origin !== expectedOrigin) {
      throw new ForbiddenError("Cross-origin requests are not allowed");
    }
    return;
  }

  // A production deployment without APP_ORIGIN is a misconfiguration: fail
  // closed rather than trusting an unverifiable origin.
  if (isProduction(config)) {
    throw new ApiError(503, "Service temporarily unavailable, please try again later");
  }
}
