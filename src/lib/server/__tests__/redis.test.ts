import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RedisConfigurationError,
  RedisUnavailableError,
  closeRedis,
  getRedis,
  redactRedisText,
} from "@/lib/redis";

/**
 * Unit tests for the Redis foundation.
 *
 * These never need a running Redis: they only cover the behaviour that must
 * hold before a connection exists — the lazy connect, the fail-fast on a
 * missing URL and the redaction of connection strings.
 */

afterEach(async () => {
  await closeRedis();
  vi.unstubAllEnvs();
});

describe("redis configuration", () => {
  it("fails fast with a clear error when no URL is configured", async () => {
    vi.stubEnv("REDIS_URL", "");

    await expect(getRedis()).rejects.toBeInstanceOf(RedisConfigurationError);
    await expect(getRedis()).rejects.toThrow(/REDIS_URL/);
  });

  it("never puts a configured URL into a thrown message", async () => {
    vi.stubEnv("REDIS_URL", "redis://user:sup3r-secret@127.0.0.1:6399");

    const error = await getRedis().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RedisUnavailableError);
    const message = error instanceof Error ? error.message : "";
    expect(message).not.toContain("sup3r-secret");
    expect(message).not.toContain("127.0.0.1");
    expect(message).not.toContain("redis://");
  });
});

describe("redaction", () => {
  it("removes connection strings", () => {
    expect(redactRedisText("failed to connect to redis://user:secret@host:6379")).toBe(
      "failed to connect to [redacted]",
    );
    expect(redactRedisText("rediss://host:6380")).toBe("[redacted]");
  });

  it("removes credential fragments", () => {
    expect(redactRedisText("command failed, password=hunter2 rejected")).toBe(
      "command failed, password=[redacted] rejected",
    );
  });

  it("keeps harmless text readable", () => {
    expect(redactRedisText("connection refused")).toBe("connection refused");
  });
});
