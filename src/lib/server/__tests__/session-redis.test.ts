import { describe, expect, it } from "vitest";
import { RedisSessionStore, clampSessionTtl } from "@/lib/server/session-redis";
import { BadRequestError } from "@/lib/server/errors";
import { MAX_SESSION_TTL_SECONDS } from "@/lib/server/session";

/**
 * Unit tests for the Redis session store.
 *
 * The digest and TTL guards run before any Redis command is issued, so these
 * assertions never need a running Redis instance.
 */

const DIGEST = "a".repeat(64);

describe("session store input guards", () => {
  it("rejects a digest that is not a SHA-256 hex digest", async () => {
    const store = new RedisSessionStore({ keyPrefix: "nana-test:" });

    for (const digest of ["", "short", "A".repeat(64), "z".repeat(64), `${DIGEST}0`, DIGEST.slice(1)]) {
      await expect(store.get(digest)).rejects.toBeInstanceOf(BadRequestError);
      await expect(store.delete(digest)).rejects.toBeInstanceOf(BadRequestError);
      await expect(
        store.put(digest, { playerId: "p", createdAt: 1, expiresAt: 2 }, 60),
      ).rejects.toBeInstanceOf(BadRequestError);
    }
  });

  it("bounds the session lifetime", () => {
    expect(clampSessionTtl(60)).toBe(60);
    expect(clampSessionTtl(0)).toBe(1);
    expect(clampSessionTtl(-30)).toBe(1);
    expect(clampSessionTtl(Number.NaN)).toBe(1);
    expect(clampSessionTtl(10 ** 9)).toBe(MAX_SESSION_TTL_SECONDS);
  });
});
