import { getRedis } from "@/lib/redis";
import { MAX_SESSION_TTL_SECONDS, type SessionRecord, type SessionStore } from "./session";
import { BadRequestError } from "./errors";
import { PLAYER_ID_PATTERN } from "./validation";

/**
 * Redis-backed session storage.
 *
 * The store implements the {@link SessionStore} contract of the in-memory
 * implementation, so the session module stays untouched and the route layer
 * can switch between both without a change:
 *
 * - A session is keyed by the SHA-256 digest of its token, so the token
 *   itself is never stored and a database leak never exposes a usable
 *   session.
 * - The digest is validated before a key is built: only a 64 character hex
 *   digest is accepted, so a malformed value can never become an arbitrary
 *   Redis key.
 * - Every write carries a bounded expiry, so a session disappears on its own.
 * - Reading never extends the expiry. The sliding refresh happens when the
 *   session is reused, exactly like the in-memory store: `reuseOrCreate`
 *   writes the record again and the new write starts a full window.
 */

/** A SHA-256 digest in lowercase hex. */
const SESSION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
/** Key prefixes are bounded in length and restricted to a safe character set. */
const KEY_PREFIX_PATTERN = /^[A-Za-z0-9:_-]{0,64}$/;

export interface RedisSessionStoreOptions {
  /** Prefix of every key, used to isolate one deployment or test run. */
  readonly keyPrefix?: string;
  /** Clock in milliseconds; defaults to the system clock. */
  readonly now?: () => number;
}

/**
 * Bounds the lifetime of a session.
 *
 * A session always lives at least one second and never longer than the
 * maximum session window of the session module.
 */
export function clampSessionTtl(ttlSeconds: number): number {
  const seconds = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : 0;
  if (seconds < 1) return 1;
  return Math.min(seconds, MAX_SESSION_TTL_SECONDS);
}

/** Whether a value is a usable session record. */
function isSessionRecord(value: unknown): value is SessionRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.playerId === "string" &&
    PLAYER_ID_PATTERN.test(record.playerId) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    record.createdAt <= record.expiresAt
  );
}

/**
 * The Redis session store.
 */
export class RedisSessionStore implements SessionStore {
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(options: RedisSessionStoreOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? "";
    this.now = options.now ?? Date.now;
    if (!KEY_PREFIX_PATTERN.test(this.keyPrefix)) {
      throw new Error("Invalid session key prefix");
    }
  }

  /**
   * The Redis key of a session.
   *
   * The digest is validated first, so a malformed value can never turn into
   * an arbitrary key.
   */
  private sessionKey(digest: string): string {
    if (typeof digest !== "string" || !SESSION_DIGEST_PATTERN.test(digest)) {
      throw new BadRequestError("Invalid session digest");
    }
    return `${this.keyPrefix}session:${digest}`;
  }

  async get(digest: string): Promise<SessionRecord | null> {
    const key = this.sessionKey(digest);
    const client = await getRedis();

    const raw = await client.get(key);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (!isSessionRecord(parsed) || parsed.expiresAt <= this.now()) {
      // An unreadable, malformed or stale record is not a session: drop it
      // and let the caller start over instead of handing out a broken identity.
      await client.del(key);
      return null;
    }

    return parsed;
  }

  async put(digest: string, record: SessionRecord, ttlSeconds: number): Promise<void> {
    const key = this.sessionKey(digest);
    if (!isSessionRecord(record)) {
      throw new BadRequestError("Invalid session record");
    }

    const client = await getRedis();
    const remainingMs = Math.floor(record.expiresAt - this.now());
    if (remainingMs < 1) {
      await client.del(key);
      throw new BadRequestError("Expired session record");
    }
    const configuredTtlMs = clampSessionTtl(ttlSeconds) * 1000;
    const ttlMs = Math.min(configuredTtlMs, remainingMs);
    await client.set(key, JSON.stringify(record), {
      expiration: { type: "PX", value: ttlMs },
    });
  }

  async delete(digest: string): Promise<void> {
    const key = this.sessionKey(digest);
    const client = await getRedis();
    await client.del(key);
  }
}
