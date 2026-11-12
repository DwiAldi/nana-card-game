import { describe, expect, it } from "vitest";
import type { ServerState } from "@/types";
import { createGameState } from "@/lib/server/game-engine";
import type { GameRepository, GameTransition } from "@/lib/server/game-repository";
import type { RateLimiter, RateLimitRequest, RateLimitResult } from "@/lib/server/rate-limit";
import {
  InMemorySessionStore,
  issueSession,
  type SessionRecord,
  type ServerConfig,
  type SessionStore,
} from "@/lib/server/session";
import { createGameApi } from "@/lib/server/game-api";

const ORIGIN = "https://cards.example.com";
const ROOM = "roomabc123";
const P1 = "a1".repeat(16);
const P2 = "b2".repeat(16);
const config: ServerConfig = {
  nodeEnv: "development",
  appOrigin: ORIGIN,
  sessionTtlSeconds: 3600,
};

class MemoryRepository implements GameRepository {
  state: ServerState | null = null;
  failure: Error | null = null;

  async createGame({ hostPlayerId, hostName }: { hostPlayerId: string; hostName: string }) {
    if (this.failure) throw this.failure;
    this.state = createGameState(ROOM, hostPlayerId, hostName, 1000);
    return structuredClone(this.state);
  }

  async readGame() {
    if (this.failure) throw this.failure;
    return this.state ? structuredClone(this.state) : null;
  }

  async updateGame(_roomId: string, transition: GameTransition) {
    if (this.failure) throw this.failure;
    if (!this.state) throw new Error("missing");
    this.state = await transition(structuredClone(this.state));
    return structuredClone(this.state);
  }

  async pollGame(_roomId: string, playerId: string) {
    if (this.failure) throw this.failure;
    if (!this.state) return null;
    if (!this.state.players.some((player) => player.id === playerId)) {
      const { ForbiddenError } = await import("@/lib/server/errors");
      throw new ForbiddenError("You are not in this game");
    }
    return structuredClone(this.state);
  }
}

class TestLimiter implements RateLimiter {
  requests: RateLimitRequest[] = [];
  result: RateLimitResult = {
    allowed: true,
    limit: 120,
    remaining: 119,
    retryAfterSeconds: 0,
    resetSeconds: 60,
  };
  async check(request: RateLimitRequest) {
    this.requests.push(request);
    return this.result;
  }
}

class TrackingSessionStore extends InMemorySessionStore {
  puts = 0;
  deletes = 0;

  override async put(digest: string, record: SessionRecord, ttlSeconds: number) {
    this.puts += 1;
    await super.put(digest, record, ttlSeconds);
  }

  override async delete(digest: string) {
    this.deletes += 1;
    await super.delete(digest);
  }
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function fixture(overrides: {
  config?: ServerConfig;
  repository?: MemoryRepository;
  sessions?: SessionStore;
} = {}) {
  const repository = overrides.repository ?? new MemoryRepository();
  const sessions = overrides.sessions ?? new InMemorySessionStore();
  const limiter = new TestLimiter();
  const api = createGameApi({
    config: overrides.config ?? config,
    repository,
    sessions,
    limiter,
    now: () => 2000,
    trustedProxyHops: 0,
  });
  return { api, repository, sessions, limiter };
}

async function authenticated(store: SessionStore, playerId: string) {
  const issued = await issueSession(store, config, () => 1000);
  const digest = (await import("@/lib/server/session")).hashSessionToken(issued.token);
  await store.put(digest, { playerId, createdAt: 1000, expiresAt: 3_601_000 }, 3600);
  return `nana_session=${issued.token}`;
}

describe("secure game API", () => {
  it("rejects malformed JSON, wrong content type, unknown actions, and oversized bodies", async () => {
    const { api } = await fixture();
    const malformed = await api.action(post("{"));
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");

    const wrongType = await api.action(new Request(`${ORIGIN}/api/action`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}",
    }));
    expect(wrongType.status).toBe(400);
    expect((await api.action(post({ action: "dance" }))).status).toBe(400);
    expect((await api.action(post(`{"action":"host","name":"${"x".repeat(8200)}"}`))).status).toBe(400);
  });

  it("enforces the configured origin before touching storage", async () => {
    const { api, repository } = await fixture();
    const response = await api.action(post({ action: "host", name: "Host" }, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(repository.state).toBeNull();
  });

  it("rejects legacy acting identities and legacy poll identity spoofing", async () => {
    const { api } = await fixture();
    expect((await api.action(post({ action: "host", name: "Host", playerId: P1 }))).status).toBe(400);
    const poll = await api.gameState(new Request(`${ORIGIN}/api/game-state?id=${ROOM}&playerId=${P1}`));
    expect(poll.status).toBe(400);
  });

  it("returns 401 for missing and forged sessions", async () => {
    const { api } = await fixture();
    expect((await api.action(post({ action: "start", roomId: ROOM }))).status).toBe(401);
    expect((await api.action(post({ action: "start", roomId: ROOM }, { cookie: "nana_session=forged" }))).status).toBe(401);
  });

  it("maps non-members, missing rooms, conflicts, throttles, and storage failures safely", async () => {
    const { api, repository, sessions, limiter } = await fixture();
    repository.state = createGameState(ROOM, P1, "Host", 1000);
    const p2Cookie = await authenticated(sessions, P2);
    expect((await api.action(post({ action: "start", roomId: ROOM }, { cookie: p2Cookie }))).status).toBe(403);

    repository.state = null;
    expect((await api.gameState(new Request(`${ORIGIN}/api/game-state?id=${ROOM}`, { headers: { cookie: p2Cookie } }))).status).toBe(404);

    repository.state = createGameState(ROOM, P2, "Host", 1000);
    expect((await api.action(post({ action: "start", roomId: ROOM }, { cookie: p2Cookie }))).status).toBe(409);

    limiter.result = { allowed: false, limit: 1, remaining: 0, retryAfterSeconds: 17, resetSeconds: 17 };
    const limited = await api.gameState(new Request(`${ORIGIN}/api/game-state?id=${ROOM}`, { headers: { cookie: p2Cookie } }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("17");

    limiter.result = { allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetSeconds: 60 };
    repository.failure = new Error("redis://secret@127.0.0.1:6379 exploded");
    const failed = await api.gameState(new Request(`${ORIGIN}/api/game-state?id=${ROOM}`, { headers: { cookie: p2Cookie } }));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("redis://");
  });

  it("hosts with a server room and viewer id and sets secure cookies only in production", async () => {
    const development = await fixture();
    const devResponse = await development.api.action(post({ action: "host", name: "Host" }));
    const devBody = await devResponse.json();
    expect(devBody.gameId).toBe(ROOM);
    expect(devBody.viewerId).toMatch(/^[a-f0-9]{32}$/);
    expect(devResponse.headers.get("set-cookie")).toContain("HttpOnly");
    expect(devResponse.headers.get("set-cookie")).not.toContain("Secure");

    const production = await fixture({ config: { ...config, nodeEnv: "production" } });
    const prodResponse = await production.api.action(post({ action: "host", name: "Host" }));
    expect(prodResponse.headers.get("set-cookie")).toContain("Secure");
  });

  it("applies the global bootstrap limit before creating an unauthenticated join session", async () => {
    const sessions = new TrackingSessionStore();
    const { api, limiter } = await fixture({ sessions });
    limiter.result = {
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 9,
      resetSeconds: 9,
    };

    const response = await api.action(post({ action: "join", roomId: ROOM, name: "Guest" }));

    expect(response.status).toBe(429);
    expect(limiter.requests).toHaveLength(1);
    expect(limiter.requests[0].kind).toBe("create");
    expect(sessions.puts).toBe(0);
  });

  it("does not apply the bootstrap limit when a valid session joins", async () => {
    const { api, repository, sessions, limiter } = await fixture();
    repository.state = createGameState(ROOM, P1, "Host", 1000);
    const cookie = await authenticated(sessions, P2);
    limiter.requests = [];

    const response = await api.action(post(
      { action: "join", roomId: ROOM, name: "Guest" },
      { cookie },
    ));

    expect(response.status).toBe(200);
    expect(limiter.requests.map((request) => request.kind)).toEqual(["join"]);
  });

  it("deletes a newly issued join session when the join fails", async () => {
    const sessions = new TrackingSessionStore();
    const repository = new MemoryRepository();
    repository.failure = new Error("storage unavailable");
    const { api } = await fixture({ sessions, repository });

    const response = await api.action(post({ action: "join", roomId: ROOM, name: "Guest" }));

    expect(response.status).toBe(503);
    expect(sessions.puts).toBe(1);
    expect(sessions.deletes).toBe(1);
  });

  it("returns a sanitized viewer projection for repeated joins and polls", async () => {
    const { api, repository } = await fixture();
    const hosted = await api.action(post({ action: "host", name: "Host" }));
    const cookie = hosted.headers.get("set-cookie")?.split(";")[0] ?? "";
    repository.state!.players[0].hand = [
      { id: "1".repeat(24), number: 7, isRevealed: false },
    ];
    repository.state!.players.push({
      id: P2, name: "Other", seat: 2, isHost: false, isPlaying: false,
      hand: [{ id: "2".repeat(24), number: 12, isRevealed: false }], collection: [],
    });

    const joined = await api.action(post({ action: "join", roomId: ROOM, name: "Host" }, { cookie }));
    expect(joined).toBeInstanceOf(Response);
    const joinedBody = await joined.json();
    expect(joinedBody.players[0].hand[0].number).toBe(7);
    expect(joinedBody.players[1].hand[0]).not.toHaveProperty("number");
    expect(JSON.stringify(joinedBody)).not.toContain("nana_session");

    const polled = await api.gameState(new Request(`${ORIGIN}/api/game-state?id=${ROOM}`, { headers: { cookie } }));
    expect(polled.status).toBe(200);
    expect(polled.headers.get("cache-control")).toBe("no-store");
  });

  it("does not reveal a second min/max card for two concurrent identical requests", async () => {
    class RetryingRepository extends MemoryRepository {
      private arrivals = 0;
      private release!: () => void;
      private readonly ready = new Promise<void>((resolve) => { this.release = resolve; });
      private markCommitted!: () => void;
      private readonly committed = new Promise<void>((resolve) => { this.markCommitted = resolve; });

      async updateGame(_roomId: string, transition: GameTransition) {
        if (!this.state) throw new Error("missing");
        const call = this.arrivals;
        this.arrivals += 1;
        const candidate = await transition(structuredClone(this.state));
        if (this.arrivals === 2) this.release();
        await this.ready;
        if (call === 0) {
          this.state = candidate;
          this.markCommitted();
          return structuredClone(candidate);
        }
        await this.committed;
        return transition(structuredClone(this.state));
      }
    }
    const repository = new RetryingRepository();
    const { api, sessions } = await fixture({ repository });
    repository.state = {
      gameId: ROOM, gameStage: "stage:in-game", gameSubStage: "sub:playing", timestamp: 1000,
      players: [
        { id: P1, name: "Host", seat: 1, isHost: true, isPlaying: true, hand: [], collection: [] },
        { id: P2, name: "Other", seat: 2, isHost: false, isPlaying: false, hand: [
          { id: "1".repeat(24), number: 2, isRevealed: false },
          { id: "2".repeat(24), number: 4, isRevealed: false },
        ], collection: [] },
      ], cardDeck: [], publicCards: [], messages: [],
    };
    const cookie = await authenticated(sessions, P1);
    const requestBody = { action: "reveal-player", roomId: ROOM, targetPlayerId: P2, minMax: "min" };
    const responses = await Promise.all([
      api.action(post(requestBody, { cookie })),
      api.action(post(requestBody, { cookie })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(repository.state.players[1].hand.filter((card) => card.isRevealed)).toHaveLength(1);
    expect(repository.state.players[1].hand[1].isRevealed).toBe(false);
  });
});
