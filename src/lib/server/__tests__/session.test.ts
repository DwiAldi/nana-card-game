import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  InMemorySessionStore,
  generatePlayerId,
  generateSessionToken,
  hashSessionToken,
  issueSession,
  loadServerConfig,
  readSessionToken,
  resolveSession,
  reuseOrCreateSession,
  sessionCookie,
  type ServerConfig,
} from "@/lib/server/session";

const productionConfig: ServerConfig = {
  nodeEnv: "production",
  appOrigin: "https://cards.example.com",
  sessionTtlSeconds: 3600,
};

const developmentConfig: ServerConfig = {
  nodeEnv: "development",
  appOrigin: "http://localhost:2333",
  sessionTtlSeconds: 3600,
};

describe("server configuration", () => {
  it("reads the configured origin and environment from the injected env", () => {
    expect(
      loadServerConfig({ NODE_ENV: "production", APP_ORIGIN: "https://cards.example.com" }),
    ).toEqual({
      nodeEnv: "production",
      appOrigin: "https://cards.example.com",
      sessionTtlSeconds: 3600,
    });
  });

  it("trims APP_ORIGIN and reports it missing when blank", () => {
    const config = loadServerConfig({ NODE_ENV: "production", APP_ORIGIN: "  " });
    expect(config.appOrigin).toBeNull();
  });

  it("uses the bounded default TTL and honors SESSION_TTL_SECONDS", () => {
    expect(loadServerConfig({}).sessionTtlSeconds).toBe(3600);
    expect(loadServerConfig({ SESSION_TTL_SECONDS: "120" }).sessionTtlSeconds).toBe(120);
    expect(loadServerConfig({ SESSION_TTL_SECONDS: "not-a-number" }).sessionTtlSeconds).toBe(3600);
    expect(loadServerConfig({ SESSION_TTL_SECONDS: "0" }).sessionTtlSeconds).toBe(3600);
  });

  it("caps an oversized configured TTL at seven days", () => {
    expect(loadServerConfig({ SESSION_TTL_SECONDS: "999999999" }).sessionTtlSeconds).toBe(604800);
    expect(loadServerConfig({ SESSION_TTL_SECONDS: "604800" }).sessionTtlSeconds).toBe(604800);
    expect(loadServerConfig({ SESSION_TTL_SECONDS: "604799" }).sessionTtlSeconds).toBe(604799);
  });
});

describe("session issuance", () => {
  it("generates a 32-byte random token and its SHA-256 digest", () => {
    const { token, digest } = generateSessionToken();
    expect(Buffer.from(token, "base64url").byteLength).toBe(32);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken(token)).toBe(digest);
  });

  it("generates a separate server-owned player id", () => {
    const playerId = generatePlayerId();
    const { token } = generateSessionToken();
    // Player ids are 128-bit lowercase hex; tokens are base64url, so the
    // two never share a format despite both being server-minted.
    expect(playerId).toMatch(/^[a-f0-9]{32}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("issues distinct tokens and player ids per session", async () => {
    const store = new InMemorySessionStore();
    const first = await issueSession(store, productionConfig);
    const second = await issueSession(store, productionConfig);
    expect(first.token).not.toBe(second.token);
    expect(first.playerId).not.toBe(second.playerId);
  });

  it("bounds the session lifetime to the configured TTL", async () => {
    const config: ServerConfig = { ...productionConfig, sessionTtlSeconds: 60 };
    let nowMs = 1_000_000;
    const store = new InMemorySessionStore(() => nowMs);
    const session = await issueSession(store, config, () => nowMs);
    expect(session.expiresAt).toBe(nowMs + 60_000);

    nowMs += 59_000;
    expect(await resolveSession(store, session.token)).not.toBeNull();

    nowMs += 2_000;
    expect(await resolveSession(store, session.token)).toBeNull();
  });

  it("stores only the token digest, never the token itself", async () => {
    const store = new InMemorySessionStore();
    const { token } = await issueSession(store, productionConfig);

    const digest = hashSessionToken(token);
    const record = await store.get(digest);
    // The digest lookup yields a record without any token field.
    expect(record).not.toBeNull();
    expect(record?.playerId).not.toBe(token);
    expect(Object.keys(record as object).sort()).toEqual(["createdAt", "expiresAt", "playerId"]);
  });

  it("resolves a session by token and returns null for forged tokens", async () => {
    const store = new InMemorySessionStore();
    const session = await issueSession(store, productionConfig);
    const record = await resolveSession(store, session.token);
    expect(record).not.toBeNull();
    expect(record?.playerId).toBe(session.playerId);
    expect(await resolveSession(store, "forged-token")).toBeNull();
    expect(await resolveSession(store, null)).toBeNull();
  });
});

describe("session reuse", () => {
  it("reuses an existing valid guest session for joins and hosting", async () => {
    let nowMs = 1_000_000;
    const store = new InMemorySessionStore(() => nowMs);
    const original = await issueSession(store, productionConfig, () => nowMs);

    nowMs += 30_000;
    const reused = await reuseOrCreateSession(store, productionConfig, original.token, () => nowMs);
    expect(reused.playerId).toBe(original.playerId);
    expect(reused.token).toBe(original.token);
    expect(reused.expiresAt).toBe(nowMs + 3600_000);
  });

  it("issues a fresh session for a missing, expired or forged token", async () => {
    let nowMs = 1_000_000;
    const store = new InMemorySessionStore(() => nowMs);
    const original = await issueSession(store, productionConfig, () => nowMs);

    for (const token of [null, "forged-token"]) {
      const issued = await reuseOrCreateSession(store, productionConfig, token, () => nowMs);
      expect(issued.token).not.toBe(original.token);
      expect(issued.playerId).not.toBe(original.playerId);
    }

    nowMs += 3601_000;
    const afterExpiry = await reuseOrCreateSession(
      store,
      productionConfig,
      original.token,
      () => nowMs,
    );
    expect(afterExpiry.playerId).not.toBe(original.playerId);
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Strict, scoped to path=/ with a bounded Max-Age", () => {
    const cookie = sessionCookie(productionConfig, "token-value");
    const attributes = cookie.split("; ").slice(1);
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Strict");
    expect(attributes).toContain("Path=/");
    expect(attributes).toContain("Max-Age=3600");
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=token-value`)).toBe(true);
  });

  it("is marked Secure in production and not in development", () => {
    expect(sessionCookie(productionConfig, "t").split("; ")).toContain("Secure");
    expect(sessionCookie(developmentConfig, "t").split("; ")).not.toContain("Secure");
    const attributes = sessionCookie(developmentConfig, "t").split("; ").slice(1);
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Strict");
  });
});

describe("cookie parsing", () => {
  it("reads the session token from a Cookie header", () => {
    expect(readSessionToken("other=1; nana_session=abc123; x=y")).toBe("abc123");
    expect(readSessionToken("nana_session=abc123")).toBe("abc123");
    expect(readSessionToken("nana_session=; other=1")).toBeNull();
    expect(readSessionToken("other=1")).toBeNull();
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken(undefined)).toBeNull();
  });

  it("tolerates whitespace around the cookie name and value", () => {
    expect(readSessionToken(" nana_session = abc123 ")).toBe("abc123");
    expect(readSessionToken("  nana_session=abc123")).toBe("abc123");
    expect(readSessionToken("other=1;  nana_session =  t0k3n ")).toBe("t0k3n");
  });
});
