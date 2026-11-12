import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { RedisClientType } from "redis";
import { getRedis } from "@/lib/redis";
import { BadRequestError } from "./errors";

/**
 * Fixed-window rate limiting.
 *
 * Every budget is a counter in Redis that is incremented and expired by a
 * single Lua script, so concurrent requests can never lose a count:
 *
 * ```lua
 * local counter = redis.call('INCR', KEYS[1])
 * if counter == 1 then
 *   redis.call('EXPIRE', KEYS[1], ARGV[1])
 * end
 * return counter
 * ```
 *
 * The expiry is only set on the first increment, which is what makes the
 * window a fixed window: the counter lives exactly as long as the window it
 * belongs to and then disappears, so a limiter key never survives on its own.
 *
 * Key safety:
 *
 * - Every key component is validated before the key is built: the prefix is
 *   length and charset bounded, the window index is a number and the caller
 *   identity is hashed into a fixed length hex digest. A malformed or
 *   hostile value can never become an arbitrary Redis key.
 * - The caller identity is a digest, never a token, a session value or chat
 *   text, so nothing secret ends up in a key (or in a log).
 *
 * Trust boundary for client addresses:
 *
 * - `X-Forwarded-For` and friends are attacker controlled and are never
 *   read directly. {@link readTrustedClientIp} only looks at a forwarded
 *   header when the deployment explicitly declares how many reverse proxies
 *   are trusted to set it.
 * - The unauthenticated creation budget is therefore enforced with a global
 *   cap: one counter for the whole deployment. The global cap is the default
 *   protection; a per-client cap is an addition for deployments that run
 *   behind a trusted proxy, never a replacement.
 */

/** A budget: how many requests are allowed inside one window. */
export interface RateLimitBudget {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The budgets the route layer enforces. */
export type RateLimitKind = "poll" | "action" | "join" | "host" | "create";

/**
 * The initial budgets.
 *
 * Polling and acting are generous enough for a normal client, joining and
 * hosting are tighter because they create server side state. `create` is the
 * unauthenticated bootstrap budget: it is enforced globally, see
 * {@link FixedWindowRateLimiter}.
 */
export const RATE_LIMIT_BUDGETS: Readonly<Record<RateLimitKind, RateLimitBudget>> = Object.freeze({
  poll: Object.freeze({ limit: 120, windowSeconds: 60 }),
  action: Object.freeze({ limit: 120, windowSeconds: 60 }),
  join: Object.freeze({ limit: 20, windowSeconds: 60 }),
  host: Object.freeze({ limit: 10, windowSeconds: 3600 }),
  create: Object.freeze({ limit: 60, windowSeconds: 60 }),
});

/** Every known kind, used to validate a kind that arrived as a string. */
export const RATE_LIMIT_KINDS: readonly RateLimitKind[] = [
  "poll",
  "action",
  "join",
  "host",
  "create",
];

/**
 * Extra seconds a counter outlives its window.
 *
 * The window is aligned to the clock, so a counter that was created at the
 * very end of a window would expire before the window ended. The linger
 * keeps the counter alive for the whole window; it never makes a counter
 * outlive its window by more than a few seconds.
 */
export const RATE_LIMIT_LINGER_SECONDS = 5;

/** The scope of a counter: one identity, one client address or the whole deployment. */
export type RateLimitScope = "session" | "ip" | "global";

/** Key prefixes are bounded in length and restricted to a safe character set. */
const KEY_PREFIX_PATTERN = /^[A-Za-z0-9:_-]{0,64}$/;
/** The caller identity: a player id or a session digest, nothing else. */
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** The hashed identity inside a key. */
const IDENTITY_DIGEST_PATTERN = /^[a-f0-9]{32}$/;

/** The longest textual representation of an IPv6 address. */
const MAX_CLIENT_IP_LENGTH = 45;

/**
 * The Lua script that increments a counter and expires it.
 *
 * The script is evaluated with `EVALSHA` and only falls back to `EVAL` when
 * the script cache of the server was flushed.
 */
export const RATE_LIMIT_SCRIPT = [
  "local counter = redis.call('INCR', KEYS[1])",
  "if counter == 1 then",
  "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
  "end",
  "return counter",
].join("\n");

/**
 * The counter behind the limiter.
 *
 * The interface exists so unit tests can replace Redis with a fake; the
 * production implementation is {@link RedisRateLimitCounter}.
 */
export interface RateLimitCounter {
  /**
   * Atomically increments the counter of `key` and returns the new value.
   *
   * The first increment also sets the expiry of the key, so the counter
   * always disappears on its own.
   */
  increment(key: string, ttlSeconds: number): Promise<number>;
}

/** What the route layer needs to answer a request. */
export interface RateLimitResult {
  /** Whether the request may proceed. */
  readonly allowed: boolean;
  /** The budget of the window. */
  readonly limit: number;
  /** How many requests are left in the current window. */
  readonly remaining: number;
  /**
   * How long the caller has to wait: `0` when the request was allowed, the
   * remaining seconds of the window otherwise. A route turns this into a
   * `Retry-After` header on a 429.
   */
  readonly retryAfterSeconds: number;
  /** The seconds until the current window ends, always at least one. */
  readonly resetSeconds: number;
}

/** A request that shall be counted against a budget. */
export interface RateLimitRequest {
  readonly kind: RateLimitKind;
  /**
   * The stable identity of the caller: a player id or a session digest.
   * Required for every session scoped budget.
   */
  readonly subject?: string | null;
  /**
   * The client address, but only when a trusted proxy supplied it. Never a
   * value that came straight from the client.
   */
  readonly clientIp?: string | null;
}

/** The limiter contract used by the route layer. */
export interface RateLimiter {
  check(request: RateLimitRequest): Promise<RateLimitResult>;
}

export interface RateLimiterOptions {
  /** Prefix of every key, used to isolate one deployment or test run. */
  readonly keyPrefix?: string;
  /** Overrides for the default budgets. */
  readonly budgets?: Partial<Record<RateLimitKind, RateLimitBudget>>;
  /** The counter behind the limiter; defaults to Redis. */
  readonly counter?: RateLimitCounter;
  /** Clock in milliseconds; defaults to the system clock. */
  readonly now?: () => number;
  /** Extra seconds a counter outlives its window. */
  readonly lingerSeconds?: number;
}

/** The window a request falls into. */
export interface RateLimitWindow {
  /** The index of the window, counted from the epoch. */
  readonly index: number;
  /** The seconds until the window ends. */
  readonly resetSeconds: number;
}

/**
 * Computes the fixed window a timestamp belongs to.
 *
 * The window is aligned to the clock, so every caller of the same window
 * shares one counter and the retry hint is exact.
 */
export function computeRateLimitWindow(
  nowMs: number,
  windowSeconds: number,
): RateLimitWindow {
  const index = Math.floor(nowMs / (windowSeconds * 1000));
  const windowEndMs = (index + 1) * windowSeconds * 1000;
  const resetSeconds = Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
  return { index, resetSeconds };
}

/** The parts a limiter key is built from. */
export interface RateLimitKeyParts {
  readonly prefix: string;
  readonly kind: RateLimitKind;
  readonly scope: RateLimitScope;
  readonly windowIndex: number;
  /** The hashed identity; empty for the global scope. */
  readonly digest: string;
}

/**
 * Builds a limiter key.
 *
 * Every part is validated here, so a key can only ever consist of bounded,
 * known components. The identity is a digest, so no caller controlled text
 * and no secret ends up in the key.
 */
export function buildRateLimitKey(parts: RateLimitKeyParts): string {
  if (!KEY_PREFIX_PATTERN.test(parts.prefix)) {
    throw new Error("Invalid rate limit key prefix");
  }
  if (!RATE_LIMIT_KINDS.includes(parts.kind)) {
    throw new BadRequestError("Invalid rate limit kind");
  }
  if (!Number.isSafeInteger(parts.windowIndex) || parts.windowIndex < 0) {
    throw new Error("Invalid rate limit window");
  }

  const base = `${parts.prefix}rl:${parts.kind}:${parts.scope}`;
  if (parts.scope === "global") return `${base}:${parts.windowIndex}`;
  if (!IDENTITY_DIGEST_PATTERN.test(parts.digest)) {
    throw new BadRequestError("Invalid rate limit identity");
  }
  return `${base}:${parts.windowIndex}:${parts.digest}`;
}

/**
 * Hashes a caller identity into the digest that becomes part of a key.
 *
 * The identity itself is never written to Redis: a player id or a session
 * digest is hashed, so a leaked key list reveals nothing about the callers.
 */
export function hashRateLimitSubject(subject: string): string {
  if (typeof subject !== "string" || !SUBJECT_PATTERN.test(subject)) {
    throw new BadRequestError("Invalid rate limit identity");
  }
  return createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 32);
}

/**
 * Validates a client address.
 *
 * Only a real IP address is accepted, so the value can never be used to
 * smuggle arbitrary text into a key.
 */
export function normalizeClientIp(value: string): string {
  const address = typeof value === "string" ? value.trim() : "";
  if (address.length === 0 || address.length > MAX_CLIENT_IP_LENGTH) {
    throw new BadRequestError("Invalid client address");
  }
  if (isIP(address) === 0) {
    throw new BadRequestError("Invalid client address");
  }
  return address;
}

/** Hashes a client address for the key, so the address itself stays out of Redis. */
function hashClientIp(address: string): string {
  return createHash("sha256").update(address, "utf8").digest("hex").slice(0, 32);
}

/** The trust configuration of the reverse proxy in front of the app. */
export interface TrustedProxyOptions {
  /**
   * How many reverse proxies in front of the application may set the client
   * address header. `0` - the default - means that no forwarded header is
   * trusted at all.
   */
  readonly trustedProxyHops: number;
  /** The header that carries the forwarded chain. Defaults to `x-forwarded-for`. */
  readonly clientIpHeader?: string;
}

/** The header a reverse proxy normally uses. */
export const DEFAULT_CLIENT_IP_HEADER = "x-forwarded-for";

/**
 * Reads the client address from a forwarded header.
 *
 * A forwarded header is attacker controlled: a client can send any value it
 * likes. The header is therefore only consulted when the deployment
 * explicitly declares its reverse proxy trusted, and only the entry that the
 * outermost trusted proxy appended is used. With one trusted proxy the last
 * entry of the chain is the address that proxy saw.
 *
 * Returns `null` whenever the address cannot be trusted: no trusted proxy,
 * a missing header, a chain that is shorter than the trusted hops or an
 * entry that is not an IP address. The caller then falls back to the global
 * cap.
 */
export function readTrustedClientIp(
  headers: { get(name: string): string | null },
  options: TrustedProxyOptions,
): string | null {
  const hops = options.trustedProxyHops;
  if (!Number.isSafeInteger(hops) || hops <= 0) return null;

  const headerName = (options.clientIpHeader ?? DEFAULT_CLIENT_IP_HEADER).trim().toLowerCase();
  if (headerName.length === 0) return null;

  const raw = headers.get(headerName);
  if (!raw) return null;

  const chain = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (chain.length < hops) return null;

  const candidate = chain[chain.length - hops];
  if (candidate.length > MAX_CLIENT_IP_LENGTH || isIP(candidate) === 0) return null;
  return candidate;
}

/**
 * The fixed-window limiter.
 *
 * The session scoped budgets (poll, action, join, host) count per caller
 * identity. The unauthenticated creation budget (`create`) counts globally,
 * so a flood of unauthenticated room creations is bounded even when no
 * client address can be trusted. When a trusted proxy did supply an address,
 * an additional per-address counter is applied on top of the global one.
 */
export class FixedWindowRateLimiter implements RateLimiter {
  private readonly prefix: string;
  private readonly budgets: Readonly<Record<RateLimitKind, RateLimitBudget>>;
  private readonly counter: RateLimitCounter;
  private readonly now: () => number;
  private readonly lingerSeconds: number;

  constructor(options: RateLimiterOptions = {}) {
    this.prefix = options.keyPrefix ?? "";
    if (!KEY_PREFIX_PATTERN.test(this.prefix)) {
      throw new Error("Invalid rate limit key prefix");
    }
    this.budgets = { ...RATE_LIMIT_BUDGETS, ...(options.budgets ?? {}) };
    for (const budget of Object.values(this.budgets)) {
      if (!Number.isSafeInteger(budget.limit) || budget.limit < 1) {
        throw new Error("Invalid rate limit budget");
      }
      if (!Number.isSafeInteger(budget.windowSeconds) || budget.windowSeconds < 1) {
        throw new Error("Invalid rate limit window");
      }
    }
    this.counter = options.counter ?? new RedisRateLimitCounter();
    this.now = options.now ?? (() => Date.now());
    this.lingerSeconds = options.lingerSeconds ?? RATE_LIMIT_LINGER_SECONDS;
    if (!Number.isSafeInteger(this.lingerSeconds) || this.lingerSeconds < 0) {
      throw new Error("Invalid rate limit linger");
    }
  }

  async check(request: RateLimitRequest): Promise<RateLimitResult> {
    const budget = this.budgets[request.kind];
    if (!budget) throw new Error(`Unknown rate limit kind: ${String(request.kind)}`);

    const window = computeRateLimitWindow(this.now(), budget.windowSeconds);
    const ttlSeconds = budget.windowSeconds + this.lingerSeconds;

    if (request.kind === "create") {
      return this.checkCreation(budget, window, ttlSeconds, request);
    }

    const subject = request.subject;
    if (typeof subject !== "string" || subject.length === 0) {
      throw new BadRequestError("A rate limited request needs an identity");
    }

    const key = buildRateLimitKey({
      prefix: this.prefix,
      kind: request.kind,
      scope: "session",
      windowIndex: window.index,
      digest: hashRateLimitSubject(subject),
    });
    const count = await this.counter.increment(key, ttlSeconds);
    return this.evaluate(count, budget, window);
  }

  /**
   * The unauthenticated path.
   *
   * The global counter is always incremented: it is the default protection
   * against a flood of room creations. A per-address counter is only added
   * when a trusted proxy supplied a usable address.
   */
  private async checkCreation(
    budget: RateLimitBudget,
    window: RateLimitWindow,
    ttlSeconds: number,
    request: RateLimitRequest,
  ): Promise<RateLimitResult> {
    // The address is validated before anything is counted: a malformed value
    // must not leave a counter behind.
    const address =
      request.clientIp === null || request.clientIp === undefined
        ? null
        : normalizeClientIp(request.clientIp);

    const globalKey = buildRateLimitKey({
      prefix: this.prefix,
      kind: "create",
      scope: "global",
      windowIndex: window.index,
      digest: "",
    });
    const globalCount = await this.counter.increment(globalKey, ttlSeconds);
    const globalResult = this.evaluate(globalCount, budget, window);
    if (!globalResult.allowed) return globalResult;

    if (!address) return globalResult;

    const ipKey = buildRateLimitKey({
      prefix: this.prefix,
      kind: "create",
      scope: "ip",
      windowIndex: window.index,
      digest: hashClientIp(address),
    });
    const ipCount = await this.counter.increment(ipKey, ttlSeconds);
    const ipResult = this.evaluate(ipCount, budget, window);
    if (!ipResult.allowed) return ipResult;

    return globalResult;
  }

  private evaluate(
    count: number,
    budget: RateLimitBudget,
    window: RateLimitWindow,
  ): RateLimitResult {
    const allowed = count <= budget.limit;
    return {
      allowed,
      limit: budget.limit,
      remaining: Math.max(0, budget.limit - count),
      retryAfterSeconds: allowed ? 0 : window.resetSeconds,
      resetSeconds: window.resetSeconds,
    };
  }
}

/** Whether an error is the answer of a server that no longer knows the script. */
function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && /NOSCRIPT/i.test(error.message);
}

/**
 * The Redis counter.
 *
 * The script is loaded once and then evaluated with `EVALSHA`, which sends
 * only the digest of the script over the wire. A server that flushed its
 * script cache answers with `NOSCRIPT`; the script is then loaded again, and
 * as a last resort the plain `EVAL` is used.
 */
export class RedisRateLimitCounter implements RateLimitCounter {
  private scriptSha: string | null = null;

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const client = await getRedis();
    const ttl = Math.max(1, Math.floor(ttlSeconds));

    if (this.scriptSha) {
      try {
        return await this.evalSha(client, this.scriptSha, key, ttl);
      } catch (error: unknown) {
        if (!isNoScriptError(error)) throw error;
        this.scriptSha = null;
      }
    }

    try {
      this.scriptSha = await client.scriptLoad(RATE_LIMIT_SCRIPT);
      return await this.evalSha(client, this.scriptSha, key, ttl);
    } catch (error: unknown) {
      if (!isNoScriptError(error)) throw error;
      this.scriptSha = null;
      // The script cache was flushed between the load and the call.
      return Number(
        await client.eval(RATE_LIMIT_SCRIPT, { keys: [key], arguments: [String(ttl)] }),
      );
    }
  }

  private async evalSha(
    client: RedisClientType,
    sha: string,
    key: string,
    ttlSeconds: number,
  ): Promise<number> {
    const reply = await client.evalSha(sha, {
      keys: [key],
      arguments: [String(ttlSeconds)],
    });
    return Number(reply);
  }
}

/** Creates a limiter backed by Redis. */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  return new FixedWindowRateLimiter(options);
}
