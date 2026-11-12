import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type RedisClientType } from "redis";
import { closeRedis } from "@/lib/redis";
import { RedisSessionStore } from "@/lib/server/session-redis";
import {
  InMemorySessionStore,
  hashSessionToken,
  issueSession,
  resolveSession,
  reuseOrCreateSession,
  type ServerConfig,
} from "@/lib/server/session";

/**
 * Redis integration tests for the session store.
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
    "Session store integration suite skipped: set TEST_REDIS_URL to a disposable Redis instance",
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const config = (sessionTtlSeconds: number): ServerConfig => ({
  nodeEnv: "test",
  appOrigin: null,
  sessionTtlSeconds,
});

let admin: RedisClientType;
let store: RedisSessionStore;

const sessionKey = (token: string): string =>
  `${KEY_PREFIX}session:${hashSessionToken(token)}`;

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
  store = new RedisSessionStore({ keyPrefix: KEY_PREFIX });
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

describeWithRedis("redis session store", () => {
  it("round-trips a session", async () => {
    const session = await issueSession(store, config(60));

    const record = await resolveSession(store, session.token);
    expect(record).not.toBeNull();
    expect(record?.playerId).toBe(session.playerId);
    expect(record?.createdAt).toBe(session.expiresAt - 60_000);
    expect(record?.expiresAt).toBe(session.expiresAt);

    // The raw token is never stored: only its digest is the lookup key.
    const stored = await admin.get(sessionKey(session.token));
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(session.token);
    expect(await admin.exists(`${KEY_PREFIX}session:${session.token}`)).toBe(0);
  });

  it("reports an unknown or forged token as missing", async () => {
    expect(await resolveSession(store, "forged-token")).toBeNull();
    expect(await resolveSession(store, null)).toBeNull();
  });

  it("expires a session and removes its key", async () => {
    const session = await issueSession(store, config(1));

    expect(await resolveSession(store, session.token)).not.toBeNull();
    expect(await admin.exists(sessionKey(session.token))).toBe(1);

    await sleep(1_500);

    expect(await resolveSession(store, session.token)).toBeNull();
    expect(await admin.exists(sessionKey(session.token))).toBe(0);
  });

  it("refreshes the session on reuse, exactly like the in-memory store", async () => {
    const redisConfig = config(2);
    const memoryConfig = config(2);
    const memory = new InMemorySessionStore();

    const redisSession = await issueSession(store, redisConfig);
    const memorySession = await issueSession(memory, memoryConfig);

    await sleep(1_100);

    const reused = await reuseOrCreateSession(store, redisConfig, redisSession.token);
    const reusedMemory = await reuseOrCreateSession(memory, memoryConfig, memorySession.token);

    // The identity and the token survive the reuse.
    expect(reused.token).toBe(redisSession.token);
    expect(reused.playerId).toBe(redisSession.playerId);
    expect(reusedMemory.token).toBe(memorySession.token);
    expect(reusedMemory.playerId).toBe(memorySession.playerId);

    // The sliding window was refreshed to a full lifetime.
    const ttl = await admin.pTTL(sessionKey(redisSession.token));
    expect(ttl).toBeGreaterThan(1_000);

    // The original expiry has passed, the refreshed session is still alive.
    await sleep(1_100);
    expect(await resolveSession(store, redisSession.token)).not.toBeNull();
    expect(await resolveSession(memory, memorySession.token)).not.toBeNull();
  });

  it("issues a fresh session when the presented token is unknown", async () => {
    const issued = await reuseOrCreateSession(store, config(60), "forged-token");
    expect(issued.token).not.toBe("forged-token");
    expect(issued.playerId).toMatch(/^[a-f0-9]{32}$/);
    expect(await resolveSession(store, issued.token)).not.toBeNull();
  });

  it("deletes a session", async () => {
    const session = await issueSession(store, config(60));

    await store.delete(hashSessionToken(session.token));

    expect(await resolveSession(store, session.token)).toBeNull();
    expect(await admin.exists(sessionKey(session.token))).toBe(0);
  });

  it("behaves like the in-memory store for the same sequence", async () => {
    const memory = new InMemorySessionStore();
    const sharedConfig = config(60);

    const redisSession = await issueSession(store, sharedConfig);
    const memorySession = await issueSession(memory, sharedConfig);

    expect((await resolveSession(store, redisSession.token))?.playerId).toBe(redisSession.playerId);
    expect((await resolveSession(memory, memorySession.token))?.playerId).toBe(
      memorySession.playerId,
    );
    expect(await resolveSession(store, "forged-token")).toBeNull();
    expect(await resolveSession(memory, "forged-token")).toBeNull();

    const reused = await reuseOrCreateSession(store, sharedConfig, redisSession.token);
    const reusedMemory = await reuseOrCreateSession(memory, sharedConfig, memorySession.token);
    // Both stores keep their own identity and token on a reuse.
    expect(reused.playerId).toBe(redisSession.playerId);
    expect(reusedMemory.playerId).toBe(memorySession.playerId);
    expect(reused.token).toBe(redisSession.token);
    expect(reusedMemory.token).toBe(memorySession.token);

    await store.delete(hashSessionToken(redisSession.token));
    await memory.delete(hashSessionToken(memorySession.token));

    expect(await resolveSession(store, redisSession.token)).toBeNull();
    expect(await resolveSession(memory, memorySession.token)).toBeNull();
  });
});
