import { describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_BUDGETS,
  FixedWindowRateLimiter,
  RedisRateLimitCounter,
  hashRateLimitSubject,
  readTrustedClientIp,
  type RateLimitCounter,
} from "@/lib/server/rate-limit";
import { BadRequestError } from "@/lib/server/errors";
import type { RedisClientType } from "redis";

/**
 * Unit tests for the fixed-window rate limiter.
 *
 * These never talk to Redis: the counter is replaced by a fake that mirrors
 * the semantics of the Lua script (an increment that only sets the expiry on
 * the first hit). What is proven here is the behaviour the route layer
 * depends on: the budgets, the window rollover, the bounding of every key
 * component and the rejection of malformed input.
 */

/** A counter that behaves like the Redis script: INCR plus EXPIRE on the first hit. */
class FakeCounter implements RateLimitCounter {
  readonly keys: string[] = [];
  readonly ttls: number[] = [];
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async increment(key: string, ttlSeconds: number): Promise<number> {
    this.keys.push(key);
    this.ttls.push(ttlSeconds);
    const nowMs = this.now();
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= nowMs) {
      this.entries.set(key, { count: 1, expiresAt: nowMs + ttlSeconds * 1000 });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }
}

const SUBJECT = "player-0123456789abcdef";

/** A headers-like object that only knows one header. */
const headersWith = (name: string, value: string): { get(key: string): string | null } => ({
  get: (key: string) => (key.toLowerCase() === name.toLowerCase() ? value : null),
});

describe("rate limit budgets", () => {
  it("uses the documented per-session budgets", () => {
    expect(RATE_LIMIT_BUDGETS.poll).toEqual({ limit: 120, windowSeconds: 60 });
    expect(RATE_LIMIT_BUDGETS.action).toEqual({ limit: 120, windowSeconds: 60 });
    expect(RATE_LIMIT_BUDGETS.join).toEqual({ limit: 20, windowSeconds: 60 });
    expect(RATE_LIMIT_BUDGETS.host).toEqual({ limit: 10, windowSeconds: 3600 });
  });

  it("keeps a separate budget for the unauthenticated creation path", () => {
    expect(RATE_LIMIT_BUDGETS.create).toBeDefined();
    expect(RATE_LIMIT_BUDGETS.create.limit).toBeGreaterThan(0);
    expect(RATE_LIMIT_BUDGETS.create.windowSeconds).toBeGreaterThan(0);
  });

  it("allows ten hosts per hour and rejects the eleventh", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({ counter, now: () => 1_000_000 });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await limiter.check({ kind: "host", subject: SUBJECT });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10 - attempt - 1);
    }

    const eleventh = await limiter.check({ kind: "host", subject: SUBJECT });
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.remaining).toBe(0);
    expect(eleventh.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("gives every identity its own budget", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({
      counter,
      now: () => 1_000_000,
      budgets: { join: { limit: 1, windowSeconds: 60 } },
    });

    expect((await limiter.check({ kind: "join", subject: SUBJECT })).allowed).toBe(true);
    expect((await limiter.check({ kind: "join", subject: "player-fedcba9876543210" })).allowed).toBe(
      true,
    );
    expect((await limiter.check({ kind: "join", subject: SUBJECT })).allowed).toBe(false);
  });

  it("counts every budget separately", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({
      counter,
      now: () => 1_000_000,
      budgets: { poll: { limit: 1, windowSeconds: 60 } },
    });

    expect((await limiter.check({ kind: "poll", subject: SUBJECT })).allowed).toBe(true);
    // The action budget is untouched by the exhausted poll budget.
    expect((await limiter.check({ kind: "action", subject: SUBJECT })).allowed).toBe(true);
    expect((await limiter.check({ kind: "poll", subject: SUBJECT })).allowed).toBe(false);
  });
});

describe("rate limit windows", () => {
  it("expires a counter at the window boundary plus linger", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({
      counter,
      now: () => 3_599_000,
      lingerSeconds: 5,
    });

    const result = await limiter.check({ kind: "host", subject: SUBJECT });

    expect(result.resetSeconds).toBe(1);
    expect(counter.ttls).toEqual([6]);
  });

  it("keeps an ordinary counter through the active window plus linger", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({
      counter,
      now: () => 0,
      lingerSeconds: 5,
    });

    await limiter.check({ kind: "host", subject: SUBJECT });

    expect(counter.ttls).toEqual([3_605]);
  });

  it("starts a new window when the previous one rolls over", async () => {
    let nowMs = 1_000_000;
    const counter = new FakeCounter(() => nowMs);
    const limiter = new FixedWindowRateLimiter({
      counter,
      now: () => nowMs,
      budgets: { poll: { limit: 1, windowSeconds: 60 } },
    });

    expect((await limiter.check({ kind: "poll", subject: SUBJECT })).allowed).toBe(true);
    expect((await limiter.check({ kind: "poll", subject: SUBJECT })).allowed).toBe(false);

    // One full window later the budget is fresh again.
    nowMs += 60_000;
    const afterRollover = await limiter.check({ kind: "poll", subject: SUBJECT });
    expect(afterRollover.allowed).toBe(true);
    expect(counter.keys[2]).not.toBe(counter.keys[0]);
  });

  it("reports a retry-after that stays inside the current window", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({
      counter,
      now: () => 1_000_000,
      budgets: { poll: { limit: 1, windowSeconds: 60 } },
    });

    await limiter.check({ kind: "poll", subject: SUBJECT });
    const denied = await limiter.check({ kind: "poll", subject: SUBJECT });

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(denied.resetSeconds).toBe(denied.retryAfterSeconds);
    // An allowed request never asks the client to wait.
    const allowed = await limiter.check({ kind: "action", subject: SUBJECT });
    expect(allowed.retryAfterSeconds).toBe(0);
    expect(allowed.resetSeconds).toBeGreaterThan(0);
  });
});

describe("redis script cache", () => {
  it("loads once and then reuses EVALSHA without plain EVAL", async () => {
    const client = {
      scriptLoad: vi.fn().mockResolvedValue("script-sha"),
      evalSha: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
      eval: vi.fn(),
    } as unknown as RedisClientType;
    const counter = new RedisRateLimitCounter(async () => client);

    await expect(counter.increment("rl:test", 60)).resolves.toBe(1);
    await expect(counter.increment("rl:test", 60)).resolves.toBe(2);

    expect(client.scriptLoad).toHaveBeenCalledTimes(1);
    expect(client.evalSha).toHaveBeenCalledTimes(2);
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("recovers atomically when the cached script is evicted", async () => {
    const noScript = new Error("NOSCRIPT No matching script. Please use EVAL.");
    const client = {
      scriptLoad: vi.fn().mockResolvedValueOnce("first-sha").mockResolvedValueOnce("second-sha"),
      evalSha: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(noScript)
        .mockRejectedValueOnce(noScript),
      eval: vi.fn().mockResolvedValue(2),
    } as unknown as RedisClientType;
    const counter = new RedisRateLimitCounter(async () => client);

    await expect(counter.increment("rl:test", 60)).resolves.toBe(1);
    await expect(counter.increment("rl:test", 60)).resolves.toBe(2);

    expect(client.scriptLoad).toHaveBeenCalledTimes(2);
    expect(client.evalSha).toHaveBeenCalledTimes(3);
    expect(client.eval).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe script TTL before issuing a Redis command", async () => {
    const client = {
      scriptLoad: vi.fn(),
      evalSha: vi.fn(),
      eval: vi.fn(),
    } as unknown as RedisClientType;
    const counter = new RedisRateLimitCounter(async () => client);

    await expect(counter.increment("rl:test", Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "Invalid rate limit TTL",
    );
    expect(client.scriptLoad).not.toHaveBeenCalled();
  });
});

describe("rate limit keys", () => {
  it("builds a bounded key that never contains the caller identity in clear", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({ counter, now: () => 1_000_000 });

    await limiter.check({ kind: "action", subject: SUBJECT });

    const key = counter.keys[0];
    expect(key).toMatch(/^rl:action:session:\d+:[a-f0-9]{32}$/);
    expect(key).not.toContain(SUBJECT);
    expect(key.length).toBeLessThan(80);
  });

  it("hashes the identity before it becomes part of a key", () => {
    const digest = hashRateLimitSubject(SUBJECT);
    expect(digest).toMatch(/^[a-f0-9]{32}$/);
    expect(digest).not.toContain(SUBJECT);
    expect(hashRateLimitSubject(SUBJECT)).toBe(digest);
    expect(hashRateLimitSubject("player-fedcba9876543210")).not.toBe(digest);
  });

  it("rejects a malformed identity without touching the counter", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({ counter, now: () => 1_000_000 });

    const malformed = [
      "",
      "short",
      "has space",
      "colon:separated",
      "newline\nvalue",
      "a".repeat(500),
      "<script>",
    ];

    for (const subject of malformed) {
      await expect(limiter.check({ kind: "poll", subject })).rejects.toBeInstanceOf(
        BadRequestError,
      );
    }

    expect(counter.keys).toHaveLength(0);
  });

  it("requires an identity for the session scoped budgets", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({ counter, now: () => 1_000_000 });

    await expect(limiter.check({ kind: "poll" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(limiter.check({ kind: "poll", subject: null })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(counter.keys).toHaveLength(0);
  });

  it("rejects a malformed client address", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({ counter, now: () => 1_000_000 });

    for (const clientIp of [
      "",
      "not-an-ip",
      "999.999.999.999",
      "x".repeat(100),
      "203.0.113.5:8080",
    ]) {
      await expect(limiter.check({ kind: "create", clientIp })).rejects.toBeInstanceOf(
        BadRequestError,
      );
    }

    expect(counter.keys).toHaveLength(0);
  });
});

describe("unauthenticated creation budget", () => {
  it("enforces one global cap for every caller", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({
      counter,
      now: () => 1_000_000,
      budgets: { create: { limit: 2, windowSeconds: 60 } },
    });

    expect((await limiter.check({ kind: "create" })).allowed).toBe(true);
    expect((await limiter.check({ kind: "create" })).allowed).toBe(true);
    const denied = await limiter.check({ kind: "create" });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);

    // Every caller shares a single counter, so the cap is global.
    expect(new Set(counter.keys).size).toBe(1);
    expect(counter.keys[0]).toContain(":global:");
  });

  it("adds a per-client counter when a trusted proxy reported an address", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({
      counter,
      now: () => 1_000_000,
      budgets: { create: { limit: 5, windowSeconds: 60 } },
    });

    await limiter.check({ kind: "create", clientIp: "203.0.113.7" });
    await limiter.check({ kind: "create", clientIp: "203.0.113.8" });

    expect(counter.keys).toHaveLength(4);
    expect(counter.keys.filter((key) => key.includes(":global:"))).toHaveLength(2);
    expect(counter.keys.filter((key) => key.includes(":ip:"))).toHaveLength(2);
    // Two different addresses never share a counter.
    expect(counter.keys[1]).not.toBe(counter.keys[3]);
  });

  it("never puts the client address in clear in a key", async () => {
    const counter = new FakeCounter();
    const limiter = new FixedWindowRateLimiter({ counter, now: () => 1_000_000 });

    await limiter.check({ kind: "create", clientIp: "203.0.113.7" });

    const ipKey = counter.keys[1];
    expect(ipKey).not.toContain("203.0.113.7");
    expect(ipKey).toMatch(/^rl:create:ip:\d+:[a-f0-9]{32}$/);
  });
});

describe("trusted proxy handling", () => {
  it("never trusts a forwarded header by default", () => {
    expect(
      readTrustedClientIp(headersWith("x-forwarded-for", "203.0.113.5"), {
        trustedProxyHops: 0,
      }),
    ).toBeNull();
  });

  it("uses the address a single trusted proxy reported", () => {
    expect(
      readTrustedClientIp(headersWith("x-forwarded-for", "203.0.113.5"), {
        trustedProxyHops: 1,
      }),
    ).toBe("203.0.113.5");
  });

  it("takes the address the outermost trusted proxy saw", () => {
    expect(
      readTrustedClientIp(headersWith("x-forwarded-for", "203.0.113.5, 198.51.100.7"), {
        trustedProxyHops: 2,
      }),
    ).toBe("203.0.113.5");
  });

  it("ignores a chain that is shorter than the trusted hops", () => {
    expect(
      readTrustedClientIp(headersWith("x-forwarded-for", "203.0.113.5"), {
        trustedProxyHops: 2,
      }),
    ).toBeNull();
  });

  it("ignores a malformed address", () => {
    expect(
      readTrustedClientIp(headersWith("x-forwarded-for", "not-an-ip"), { trustedProxyHops: 1 }),
    ).toBeNull();
  });

  it("ignores a missing header", () => {
    expect(
      readTrustedClientIp(headersWith("x-forwarded-for", ""), { trustedProxyHops: 1 }),
    ).toBeNull();
  });
});
