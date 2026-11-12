import { describe, expect, it } from "vitest";
import { RedisGameRepository } from "@/lib/server/game-repository";

describe("RedisGameRepository options", () => {
  it.each([
    { keyPrefix: "contains space:" },
    { keyPrefix: "slash/not-safe:" },
    { keyPrefix: `${"a".repeat(129)}:` },
  ])("rejects an unsafe key prefix: $keyPrefix", (options) => {
    expect(() => new RedisGameRepository(options)).toThrow(/key prefix/i);
  });

  it.each([
    { ttlSeconds: 0 },
    { ttlSeconds: -1 },
    { ttlSeconds: 1.5 },
    { ttlSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { maxRoomIdAttempts: 0 },
    { maxRoomIdAttempts: 1.5 },
    { maxUpdateAttempts: -1 },
    { maxUpdateAttempts: Number.POSITIVE_INFINITY },
  ])("rejects invalid bounded-integer options: $options", (options) => {
    expect(() => new RedisGameRepository(options)).toThrow(/positive safe integer/i);
  });

  it.each([{}, { keyPrefix: "game:" }, { keyPrefix: "nana-itest:run-123:" }])(
    "accepts existing safe prefix forms",
    (options) => {
      expect(() => new RedisGameRepository(options)).not.toThrow();
    },
  );
});
