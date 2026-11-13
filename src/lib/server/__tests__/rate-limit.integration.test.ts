import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type RedisClientType } from "redis";
import { closeRedis } from "@/lib/redis";
import {
  FixedWindowRateLimiter,
  RedisRateLimitCounter,
} from "@/lib/server/rate-limit";

/**
 * Redis integration tests for the rate limiter.
 *
 * The suite runs against a real Redis instance and is gated on
 * `TEST_REDIS_URL`. Without it the whole suite is skipped with an explicit
 * message: a missing disposable Redis must never silently turn into a
 * passing run.
 *
 * Every key this suite creates lives under a per-run prefix
 * (`nana-itest:<run id>:`) and only those keys are deleted afterwards.
 */

const TEST_REDIS_URL = process.env.TEST_REDIS_URL?.trim() ?? "";
const hasTestRedis = TEST_REDIS_URL.length > 0;

if (!hasTestRedis) {
  it.skip(
    "Rate limit integration suite skipped: set TEST_REDIS_URL to a disposable Redis instance",
    () => {
      // Intentionally empty: the skip reason is the test title.
    },
  );
}

const describeWithRedis = hasTestRedis ? describe : describe.skip;

/** Unique per run, so two concurrent runs never share a key space. */
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const KEY_PREFIX = `nana-itest:${RUN_ID}:`;

const SUBJECT = "player-0123456789abcdef";

const pollUntil = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Redis state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

let admin: RedisClientType;

const listKeys = async (pattern: string): Promise<string[]> => {
  const keys: string[] = [];
  for await (const batch of admin.scanIterator({ MATCH: pattern, COUNT: 200 })) {
    keys.push(...batch);
  }
  return keys;
};

beforeAll(async () => {
  if (!hasTestRedis) return;
  // The server modules read REDIS_URL; the disposable instance is injected
  // through it so no production configuration is touched.
  vi.stubEnv("REDIS_URL", TEST_REDIS_URL);
  admin = createClient({
    url: TEST_REDIS_URL,
    socket: { connectTimeout: 5_000, reconnectStrategy: () => false },
  });
  admin.on("error", () => {
    // The suite asserts on failures explicitly; an unhandled error event
    // would crash the worker.
  });
  await admin.connect();
});

afterAll(async () => {
  if (!hasTestRedis) return;
  // Delete only the keys this run created.
  const keys = await listKeys(`${KEY_PREFIX}*`);
  if (keys.length > 0) await admin.del(keys);
  await admin.close();
  await closeRedis();
  vi.unstubAllEnvs();
});

describeWithRedis("redis rate limiter", () => {
  it("counts every concurrent request without losing a single one", async () => {
    const prefix = `${KEY_PREFIX}concurrent:`;
    const limiter = new FixedWindowRateLimiter({
      keyPrefix: prefix,
      counter: new RedisRateLimitCounter(),
      budgets: { poll: { limit: 20, windowSeconds: 60 } },
    });

    const results = await Promise.all(
      Array.from({ length: 60 }, () => limiter.check({ kind: "poll", subject: SUBJECT })),
    );

    // Exactly the budget was served; the rest was rejected.
    expect(results.filter((result) => result.allowed)).toHaveLength(20);
    expect(results.filter((result) => !result.allowed)).toHaveLength(40);

    // The counter holds every request: no increment was lost.
    const keys = await listKeys(`${prefix}*`);
    expect(keys).toHaveLength(1);
    expect(Number(await admin.get(keys[0]))).toBe(60);
  });

  it("serves the whole budget of concurrent callers of different identities", async () => {
    const prefix = `${KEY_PREFIX}identities:`;
    const limiter = new FixedWindowRateLimiter({
      keyPrefix: prefix,
      counter: new RedisRateLimitCounter(),
      budgets: { join: { limit: 2, windowSeconds: 60 } },
    });

    const subjects = [
      "player-0000000000000001",
      "player-0000000000000002",
      "player-0000000000000003",
    ];
    const results = await Promise.all(
      subjects.flatMap((subject) =>
        Array.from({ length: 3 }, () => limiter.check({ kind: "join", subject })),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(6);
    const keys = await listKeys(`${prefix}*`);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(Number(await admin.get(key))).toBe(3);
    }
  });

  it("expires the limiter key", async () => {
    const prefix = `${KEY_PREFIX}expiry:`;
    const limiter = new FixedWindowRateLimiter({
      keyPrefix: prefix,
      counter: new RedisRateLimitCounter(),
      budgets: { poll: { limit: 5, windowSeconds: 1 } },
      lingerSeconds: 1,
    });

    await limiter.check({ kind: "poll", subject: SUBJECT });

    const keys = await listKeys(`${prefix}*`);
    expect(keys).toHaveLength(1);
    const ttl = await admin.pTTL(keys[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3_000);

    // The counter does not survive its window.
    await pollUntil(async () => (await admin.exists(keys[0])) === 0);
    expect(await admin.exists(keys[0])).toBe(0);
  });

  it("keeps one global counter for the unauthenticated creation path", async () => {
    const prefix = `${KEY_PREFIX}global:`;
    const limiter = new FixedWindowRateLimiter({
      keyPrefix: prefix,
      counter: new RedisRateLimitCounter(),
      budgets: { create: { limit: 3, windowSeconds: 60 } },
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => limiter.check({ kind: "create" })),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    const keys = await listKeys(`${prefix}*`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(":global:");
    expect(Number(await admin.get(keys[0]))).toBe(5);
  });

  it("reports a retry-after that a route can turn into a Retry-After header", async () => {
    const prefix = `${KEY_PREFIX}retry:`;
    const limiter = new FixedWindowRateLimiter({
      keyPrefix: prefix,
      counter: new RedisRateLimitCounter(),
      budgets: { action: { limit: 1, windowSeconds: 60 } },
    });

    const allowed = await limiter.check({ kind: "action", subject: SUBJECT });
    expect(allowed.allowed).toBe(true);
    expect(allowed.retryAfterSeconds).toBe(0);

    const denied = await limiter.check({ kind: "action", subject: SUBJECT });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(denied.remaining).toBe(0);
  });

});
