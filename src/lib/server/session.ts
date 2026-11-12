import { createHash, randomBytes } from "node:crypto";

/**
 * Server-side guest sessions.
 *
 * A session is a 32-byte cryptographically random token delivered to the
 * browser in an HttpOnly cookie. Storage is keyed only by the SHA-256 digest
 * of the token, so a database leak never exposes usable tokens. The player id
 * is a separate server-generated value; clients never choose it and the token
 * never appears in JSON responses or public state.
 */

export const SESSION_COOKIE_NAME = "nana_session";
export const SESSION_TOKEN_BYTES = 32;
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;

/**
 * The minimal environment surface these modules read. Injectable so tests
 * never mutate process.env. The repository stage swaps the session store for
 * Redis without changing this surface.
 */
export interface ServerEnv {
  readonly NODE_ENV?: string;
  readonly APP_ORIGIN?: string;
  readonly SESSION_TTL_SECONDS?: string;
}
export interface ServerConfig {
  readonly nodeEnv: string;
  /** Configured public origin (APP_ORIGIN). Required in production. */
  readonly appOrigin: string | null;
  readonly sessionTtlSeconds: number;
}

export function loadServerConfig(env: ServerEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const appOrigin = env.APP_ORIGIN?.trim() ? env.APP_ORIGIN.trim() : null;

  const parsedTtl = Number.parseInt(env.SESSION_TTL_SECONDS ?? "", 10);
  const sessionTtlSeconds =
    Number.isSafeInteger(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_SESSION_TTL_SECONDS;

  return { nodeEnv, appOrigin, sessionTtlSeconds };
}

export function isProduction(config: ServerConfig): boolean {
  return config.nodeEnv === "production";
}

export interface SessionRecord {
  readonly playerId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Storage contract for sessions. Lookups are keyed by the SHA-256 token
 * digest only; the raw token is never persisted.
 */
export interface SessionStore {
  get(digest: string): Promise<SessionRecord | null>;
  put(digest: string, record: SessionRecord, ttlSeconds: number): Promise<void>;
  delete(digest: string): Promise<void>;
}

/**
 * Testable in-memory implementation with an injectable clock. Expired
 * entries are dropped on access, keeping the TTL bounded.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, { record: SessionRecord; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(digest: string): Promise<SessionRecord | null> {
    const entry = this.entries.get(digest);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(digest);
      return null;
    }
    return entry.record;
  }

  async put(digest: string, record: SessionRecord, ttlSeconds: number): Promise<void> {
    this.entries.set(digest, { record, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async delete(digest: string): Promise<void> {
    this.entries.delete(digest);
  }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateSessionToken(): { token: string; digest: string } {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  return { token, digest: hashSessionToken(token) };
}

export function generatePlayerId(): string {
  return randomBytes(16).toString("hex");
}

export interface IssuedSession {
  readonly token: string;
  readonly playerId: string;
  readonly expiresAt: number;
}

export async function issueSession(
  store: SessionStore,
  config: ServerConfig,
  now: () => number = Date.now,
): Promise<IssuedSession> {
  const { token, digest } = generateSessionToken();
  const playerId = generatePlayerId();
  const createdAt = now();
  const expiresAt = createdAt + config.sessionTtlSeconds * 1000;
  await store.put(digest, { playerId, createdAt, expiresAt }, config.sessionTtlSeconds);
  return { token, playerId, expiresAt };
}

export async function resolveSession(
  store: SessionStore,
  token: string | null,
): Promise<SessionRecord | null> {
  if (!token) return null;
  return store.get(hashSessionToken(token));
}

/**
 * Reuses an existing valid guest session for joins and hosting; issues a
 * fresh one otherwise. On reuse the sliding TTL is refreshed, still bounded
 * by the configured window.
 */
export async function reuseOrCreateSession(
  store: SessionStore,
  config: ServerConfig,
  existingToken: string | null,
  now: () => number = Date.now,
): Promise<IssuedSession> {
  const existing = await resolveSession(store, existingToken);
  if (existing && existingToken) {
    const expiresAt = now() + config.sessionTtlSeconds * 1000;
    const record: SessionRecord = { ...existing, expiresAt };
    await store.put(hashSessionToken(existingToken), record, config.sessionTtlSeconds);
    return { token: existingToken, playerId: existing.playerId, expiresAt };
  }
  return issueSession(store, config, now);
}

/**
 * Serializes the session cookie. HttpOnly and SameSite=Strict in every
 * environment; Secure only when running in production so development over
 * plain http://localhost still receives the cookie.
 */
export function sessionCookie(config: ServerConfig, token: string): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${config.sessionTtlSeconds}`,
  ];
  if (isProduction(config)) attributes.push("Secure");
  return attributes.join("; ");
}

export function readSessionToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(separator + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
