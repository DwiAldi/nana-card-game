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
/** Upper bound on the accepted session window: seven days. */
export const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

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
  const configuredTtl =
    Number.isSafeInteger(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_SESSION_TTL_SECONDS;
  // Cap the accepted window at seven days so a stray environment value
  // cannot keep guest sessions alive indefinitely.
  const sessionTtlSeconds = Math.min(configuredTtl, MAX_SESSION_TTL_SECONDS);

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

/**
 * Resolves a session and returns the digest the lookup was keyed by alongside
 * the record, so callers that refresh the record can reuse the digest without
 * re-hashing the token. Internal; the public entry point is resolveSession.
 */
interface ResolvedSession {
  readonly digest: string;
  readonly record: SessionRecord;
}

async function resolveSessionWithDigest(
  store: SessionStore,
  token: string | null,
): Promise<ResolvedSession | null> {
  if (!token) return null;
  const digest = hashSessionToken(token);
  const record = await store.get(digest);
  return record ? { digest, record } : null;
}

export async function resolveSession(
  store: SessionStore,
  token: string | null,
): Promise<SessionRecord | null> {
  return (await resolveSessionWithDigest(store, token))?.record ?? null;
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
  if (existingToken) {
    const resolved = await resolveSessionWithDigest(store, existingToken);
    if (resolved) {
      const expiresAt = now() + config.sessionTtlSeconds * 1000;
      const record: SessionRecord = { ...resolved.record, expiresAt };
      await store.put(resolved.digest, record, config.sessionTtlSeconds);
      return { token: existingToken, playerId: record.playerId, expiresAt };
    }
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
