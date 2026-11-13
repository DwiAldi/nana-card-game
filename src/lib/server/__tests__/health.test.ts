import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthHandler } from "../health";

describe("Redis health handler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns only an ok status after Redis responds", async () => {
    const GET = createHealthHandler(async () => "PONG", 100);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a generic unavailable response when Redis fails", async () => {
    const GET = createHealthHandler(async () => {
      throw new Error("redis://user:secret@redis:6379");
    }, 100);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "unavailable" });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("bounds a Redis health check that never settles", async () => {
    vi.useFakeTimers();
    const GET = createHealthHandler(
      () => new Promise<never>(() => undefined),
      100,
    );

    const responsePromise = GET();
    await vi.advanceTimersByTimeAsync(100);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
