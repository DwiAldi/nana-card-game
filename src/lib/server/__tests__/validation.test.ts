import { describe, expect, it } from "vitest";
import {
  ApiError,
  BadRequestError,
  ForbiddenError,
  jsonNoStore,
  toErrorResponse,
} from "@/lib/server/errors";
import { checkMutationOrigin, readJsonBody } from "@/lib/server/request";
import type { ServerConfig } from "@/lib/server/session";
import {
  MAX_BODY_BYTES,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_PLAYER_NAME_LENGTH,
  parseActionInput,
  validateCardId,
  validateChatMessage,
  validateMinMax,
  validatePlayerName,
  validateRoomId,
  validateTargetPlayerId,
} from "@/lib/server/validation";

const productionConfig: ServerConfig = {
  nodeEnv: "production",
  appOrigin: "https://cards.example.com",
  sessionTtlSeconds: 3600,
};

const developmentConfig: ServerConfig = {
  nodeEnv: "development",
  appOrigin: null,
  sessionTtlSeconds: 3600,
};

/** A JSON body whose UTF-8 byte length is exactly `size` bytes. */
const jsonBodyOfSize = (size: number): string =>
  `{"n":"${"a".repeat(Math.max(0, size - 8))}"}`;

const jsonRequest = (
  body: string,
  headers: Record<string, string> = {},
): Request =>
  new Request("https://cards.example.com/api/action", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

/** Builds a request from a chunked stream body, so no Content-Length is set. */
const streamRequest = (chunks: string[], contentType = "application/json"): Request => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("https://cards.example.com/api/action", {
    method: "POST",
    headers: { "content-type": contentType },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
};

const originRequest = (
  headers: Record<string, string | null> = {},
): Request => {
  const defined = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  return new Request("https://cards.example.com/api/action", {
    method: "POST",
    headers: defined,
  });
};

describe("action parsing", () => {
  it("parses a host action with only a player name", () => {
    expect(parseActionInput({ action: "host", name: "Aldi" })).toEqual({
      action: "host",
      name: "Aldi",
    });
  });

  it("parses a join action with room id and player name", () => {
    expect(
      parseActionInput({ action: "join", roomId: "m3xk9p2f", name: "Aldi" }),
    ).toEqual({ action: "join", roomId: "m3xk9p2f", name: "Aldi" });
  });

  it("parses a start action with room id only", () => {
    expect(parseActionInput({ action: "start", roomId: "m3xk9p2f" })).toEqual({
      action: "start",
      roomId: "m3xk9p2f",
    });
  });

  it("parses a public reveal action with room and card id", () => {
    expect(
      parseActionInput({ action: "reveal-public", roomId: "m3xk9p2f", cardId: "7-b" }),
    ).toEqual({ action: "reveal-public", roomId: "m3xk9p2f", cardId: "7-b" });
  });

  it("parses a player reveal action with room, target player and min/max", () => {
    expect(
      parseActionInput({
        action: "reveal-player",
        roomId: "m3xk9p2f",
        targetPlayerId: "a".repeat(32),
        minMax: "min",
      }),
    ).toEqual({
      action: "reveal-player",
      roomId: "m3xk9p2f",
      targetPlayerId: "a".repeat(32),
      minMax: "min",
    });
  });

  it("parses a chat action with room id and message", () => {
    expect(
      parseActionInput({ action: "chat", roomId: "m3xk9p2f", message: "hi" }),
    ).toEqual({ action: "chat", roomId: "m3xk9p2f", message: "hi" });
  });

  it("rejects unknown action names including legacy prefixed names", () => {
    for (const body of [
      { action: "action:host" },
      { action: "host-room" },
      { action: "" },
      {},
    ]) {
      expect(() => parseActionInput(body)).toThrow(ApiError);
    }
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, "host", 42, []]) {
      expect(() => parseActionInput(body)).toThrow(BadRequestError);
    }
  });

  it("rejects client-supplied acting identity fields from the legacy protocol", () => {
    expect(() =>
      parseActionInput({
        action: "join",
        roomId: "m3xk9p2f",
        name: "Aldi",
        playerId: "spoofed-player-id",
      }),
    ).toThrow(BadRequestError);

    expect(() =>
      parseActionInput({
        action: "join",
        roomId: "m3xk9p2f",
        name: "Aldi",
        data: { playerId: "spoofed-player-id", playerName: "Aldi" },
      }),
    ).toThrow(BadRequestError);

    expect(() =>
      parseActionInput({
        action: "host",
        name: "Aldi",
        gameId: "m3xk9p2f",
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects any unexpected property on every action", () => {
    expect(() =>
      parseActionInput({ action: "start", roomId: "m3xk9p2f", extra: true }),
    ).toThrow(BadRequestError);
    expect(() =>
      parseActionInput({ action: "chat", roomId: "m3xk9p2f", message: "hi", name: "x" }),
    ).toThrow(BadRequestError);
  });
});

describe("field validators", () => {
  it("accepts player names up to 40 characters and trims whitespace", () => {
    expect(validatePlayerName("  Aldi  ")).toBe("Aldi");
    expect(validatePlayerName("a".repeat(MAX_PLAYER_NAME_LENGTH))).toHaveLength(40);
  });

  it("rejects blank and overlong player names", () => {
    for (const name of ["", "   ", "\n\t", "a".repeat(MAX_PLAYER_NAME_LENGTH + 1)]) {
      expect(() => validatePlayerName(name)).toThrow(BadRequestError);
    }
    expect(() => validatePlayerName(42)).toThrow(BadRequestError);
  });

  it("rejects C0 control characters in player names while trimming still works", () => {
    // Interior control characters, including the U+001F and U+007F boundaries.
    for (const name of ["Ald\u0000i", "\u001F", "Aldi\u007F", "Al\u000Bdi"]) {
      expect(() => validatePlayerName(name)).toThrow(BadRequestError);
    }
    // Whitespace trimming is unaffected; the printable range U+0020+ is fine.
    expect(validatePlayerName("  Aldi  ")).toBe("Aldi");
    expect(validatePlayerName("Al di")).toBe("Al di");
  });

  it("accepts chat messages up to 500 characters", () => {
    expect(validateChatMessage("hello")).toBe("hello");
    expect(validateChatMessage("a".repeat(MAX_CHAT_MESSAGE_LENGTH))).toHaveLength(500);
  });

  it("rejects blank and overlong chat messages", () => {
    for (const message of ["", "   ", "a".repeat(MAX_CHAT_MESSAGE_LENGTH + 1)]) {
      expect(() => validateChatMessage(message)).toThrow(BadRequestError);
    }
  });

  it("rejects C0 control characters in chat messages while trimming still works", () => {
    for (const message of ["hello\u0000world", "\u001F", "msg\u007F", "hi\u001Bthere"]) {
      expect(() => validateChatMessage(message)).toThrow(BadRequestError);
    }
    expect(validateChatMessage("  hello there  ")).toBe("hello there");
  });

  it("validates room ids against a bounded ASCII format", () => {
    expect(validateRoomId("m3xk9p2f")).toBe("m3xk9p2f");
    expect(validateRoomId("abcd")).toBe("abcd");
    for (const roomId of ["abc", "a".repeat(33), "room-1!", "rööm", ""]) {
      expect(() => validateRoomId(roomId)).toThrow(BadRequestError);
    }
  });

  it("validates card ids against the known card format", () => {
    for (const cardId of ["1-a", "9-c", "10-b", "12-a"]) {
      expect(validateCardId(cardId)).toBe(cardId);
    }
    for (const cardId of ["13-a", "0-a", "1-", "1-cc", "2-A", "card-1"]) {
      expect(() => validateCardId(cardId)).toThrow(BadRequestError);
    }
  });

  it("validates target player ids as server-generated identifiers", () => {
    expect(validateTargetPlayerId("f".repeat(32))).toBe("f".repeat(32));
    for (const playerId of ["spoofed", "a".repeat(31), "A".repeat(32), "a".repeat(33)]) {
      expect(() => validateTargetPlayerId(playerId)).toThrow(BadRequestError);
    }
  });

  it("accepts only the exact min/max literals", () => {
    expect(validateMinMax("min")).toBe("min");
    expect(validateMinMax("max")).toBe("max");
    for (const value of ["MIN", "middle", 1, null]) {
      expect(() => validateMinMax(value as string)).toThrow(BadRequestError);
    }
  });

  it("rejects invalid min/max during action parsing", () => {
    expect(() =>
      parseActionInput({
        action: "reveal-player",
        roomId: "m3xk9p2f",
        targetPlayerId: "a".repeat(32),
        minMax: "middle",
      }),
    ).toThrow(BadRequestError);
  });
});

describe("request body reading", () => {
  it("parses a JSON body under the byte limit", async () => {
    const body = jsonBodyOfSize(MAX_BODY_BYTES - 1);
    await expect(readJsonBody(jsonRequest(body))).resolves.toEqual({
      n: "a".repeat(MAX_BODY_BYTES - 9),
    });
  });

  it("accepts a body of exactly 8192 bytes", async () => {
    await expect(readJsonBody(jsonRequest(jsonBodyOfSize(MAX_BODY_BYTES)))).resolves.toBeTruthy();
  });

  it("rejects a body over the byte limit even with a lying small Content-Length", async () => {
    const body = jsonBodyOfSize(MAX_BODY_BYTES + 1);
    await expect(
      readJsonBody(jsonRequest(body, { "content-length": "10" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a body over the byte limit when Content-Length is absent", async () => {
    await expect(
      readJsonBody(streamRequest([jsonBodyOfSize(MAX_BODY_BYTES + 1)])),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("enforces the limit across accumulated chunks without Content-Length", async () => {
    await expect(
      readJsonBody(streamRequest([jsonBodyOfSize(6000), jsonBodyOfSize(3000)])),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("parses a valid JSON body split across multiple chunks", async () => {
    // Exercises the byte-offset accumulation path: chunks must be joined at
    // the right offsets before decoding, not merely concatenated.
    await expect(
      readJsonBody(streamRequest(['{"action":"hos', 't","name":"Ald', 'i"}'])),
    ).resolves.toEqual({ action: "host", name: "Aldi" });
  });

  it("does not trust an inflated Content-Length for small bodies", async () => {
    await expect(
      readJsonBody(jsonRequest(jsonBodyOfSize(64), { "content-length": "999999" })),
    ).resolves.toBeTruthy();
  });

  it("rejects missing or wrong content types", async () => {
    await expect(
      readJsonBody(streamRequest([jsonBodyOfSize(32)], "text/plain")),
    ).rejects.toMatchObject({ status: 400 });

    const noType = new Request("https://cards.example.com/api/action", {
      method: "POST",
      body: jsonBodyOfSize(32),
    });
    await expect(readJsonBody(noType)).rejects.toMatchObject({ status: 400 });
  });

  it("accepts an application/json content type with charset parameters", async () => {
    await expect(
      readJsonBody(jsonRequest(jsonBodyOfSize(32), { "content-type": "application/json; charset=utf-8" })),
    ).resolves.toBeTruthy();
  });

  it("rejects malformed JSON", async () => {
    await expect(readJsonBody(jsonRequest("{not json"))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects an empty body", async () => {
    await expect(readJsonBody(jsonRequest(""))).rejects.toMatchObject({ status: 400 });
  });

  it("maps a mid-stream read error to a bad request, not a 503", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"action":"host","na'));
        controller.error(new Error("client went away"));
      },
    });
    const request = new Request("https://cards.example.com/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readJsonBody(request)).rejects.toMatchObject({ status: 400 });
  });
});

describe("mutation origin checks", () => {
  it("accepts a production mutation whose Origin matches APP_ORIGIN exactly", () => {
    expect(() =>
      checkMutationOrigin(originRequest({ origin: "https://cards.example.com" }), productionConfig),
    ).not.toThrow();
  });

  it("rejects production mutations with a foreign Origin", () => {
    expect(() =>
      checkMutationOrigin(originRequest({ origin: "https://evil.example" }), productionConfig),
    ).toThrow(ForbiddenError);
    expect(() =>
      checkMutationOrigin(
        originRequest({ origin: "https://cards.example.com.evil.example" }),
        productionConfig,
      ),
    ).toThrow(ForbiddenError);
  });

  it("rejects production mutations with an absent Origin header", () => {
    expect(() => checkMutationOrigin(originRequest({ origin: null }), productionConfig)).toThrow(
      ForbiddenError,
    );
  });

  it("rejects cross-site and same-site fetch metadata even with a matching Origin", () => {
    for (const secFetchSite of ["cross-site", "same-site"]) {
      expect(() =>
        checkMutationOrigin(
          originRequest({ origin: "https://cards.example.com", "sec-fetch-site": secFetchSite }),
          productionConfig,
        ),
      ).toThrow(ForbiddenError);
    }
  });

  it("allows same-origin and user-initiated fetch metadata", () => {
    for (const secFetchSite of ["same-origin", "none"]) {
      expect(() =>
        checkMutationOrigin(
          originRequest({ origin: "https://cards.example.com", "sec-fetch-site": secFetchSite }),
          productionConfig,
        ),
      ).not.toThrow();
    }
  });

  it("ignores forwarded headers when deciding the origin", () => {
    expect(() =>
      checkMutationOrigin(
        originRequest({
          origin: "https://cards.example.com",
          "x-forwarded-host": "evil.example",
          "x-forwarded-for": "203.0.113.7",
          forwarded: "for=203.0.113.7;host=evil.example",
        }),
        productionConfig,
      ),
    ).not.toThrow();
  });

  it("in development still requires a present Origin header", () => {
    expect(() => checkMutationOrigin(originRequest({ origin: null }), developmentConfig)).toThrow(
      ForbiddenError,
    );
    expect(() =>
      checkMutationOrigin(originRequest({ origin: "http://localhost:2333" }), developmentConfig),
    ).not.toThrow();
  });

  it("in development compares against APP_ORIGIN when one is configured", () => {
    const config: ServerConfig = { ...developmentConfig, appOrigin: "http://localhost:2333" };
    expect(() =>
      checkMutationOrigin(originRequest({ origin: "http://localhost:2333" }), config),
    ).not.toThrow();
    expect(() =>
      checkMutationOrigin(originRequest({ origin: "https://evil.example" }), config),
    ).toThrow(ForbiddenError);
  });

  it("treats a production deployment without APP_ORIGIN as a service failure", () => {
    const config: ServerConfig = { ...productionConfig, appOrigin: null };
    expect(() =>
      checkMutationOrigin(originRequest({ origin: "https://cards.example.com" }), config),
    ).toThrow(ApiError);
  });
});

describe("error mapping and JSON responses", () => {
  it("exposes safe messages for known API errors", () => {
    const response = toErrorResponse(new BadRequestError("Player name is required"));
    expect(response.status).toBe(400);
  });

  it("maps unknown internal and storage exceptions to a generic 503", async () => {
    for (const error of [
      new Error("connect ECONNREFUSED 127.0.0.1:6379 redis://:secret@10.0.0.5"),
      "string failure",
      undefined,
    ]) {
      const response = toErrorResponse(error);
      expect(response.status).toBe(503);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).not.toContain("ECONNREFUSED");
      expect(payload.error).not.toContain("secret");
      expect(payload.error).not.toContain("redis");
    }
  });

  it("sends JSON responses with Cache-Control: no-store", async () => {
    const response = jsonNoStore({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true });

    const errorResponse = toErrorResponse(new BadRequestError("nope"));
    expect(errorResponse.headers.get("cache-control")).toBe("no-store");
  });
});
