import { afterEach, describe, expect, it, vi } from "vitest";
import { gameApi, GameApiError } from "../client-api";

afterEach(() => vi.unstubAllGlobals());

describe("client game API", () => {
  it("sends same-origin JSON without a client identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ gameId: "roomabc123", viewerId: "viewer" }));
    vi.stubGlobal("fetch", fetchMock);
    await gameApi.host("Host");
    expect(fetchMock).toHaveBeenCalledWith("/api/action", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "host", name: "Host" }),
    }));
    expect(fetchMock.mock.calls[0][1].body).not.toContain("playerId");
  });

  it("returns typed retry information from a 429 without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(
      { error: "Slow down", retryAfterSeconds: 9 },
      { status: 429, headers: { "retry-after": "9" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(gameApi.poll("roomabc123")).rejects.toMatchObject({
      name: "GameApiError",
      status: 429,
      retryAfterSeconds: 9,
      message: "Slow down",
    } satisfies Partial<GameApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the secure payload contract for every action and poll", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ gameId: "roomabc123", viewerId: "viewer" }));
    vi.stubGlobal("fetch", fetchMock);
    await gameApi.join("roomabc123", "Guest");
    await gameApi.start("roomabc123");
    await gameApi.revealPublic("roomabc123", "1".repeat(24));
    await gameApi.revealPlayer("roomabc123", "a".repeat(32), "min");
    await gameApi.chat("roomabc123", "hello");
    await gameApi.poll("roomabc123");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/game-state?id=roomabc123");
    for (const call of fetchMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("playerId");
    }
  });
});
