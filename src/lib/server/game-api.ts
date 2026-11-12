import type { GameAction } from "./game-engine";
import { applyGameAction } from "./game-engine";
import { ApiError, NotFoundError, UnauthorizedError, jsonNoStore, toErrorResponse } from "./errors";
import type { GameRepository } from "./game-repository";
import type { RateLimiter, RateLimitKind, RateLimitResult } from "./rate-limit";
import { readTrustedClientIp } from "./rate-limit";
import { checkMutationOrigin, readJsonBody } from "./request";
import {
  readSessionToken,
  resolveSession,
  reuseOrCreateSession,
  sessionCookie,
  hashSessionToken,
  type ServerConfig,
  type SessionStore,
} from "./session";
import { parseActionInput, validateRoomId, type ActionRequest } from "./validation";
import { toPublicState } from "./public-state";
import { findUnrevealedCardId } from "../game-helper";

export interface GameApiDependencies {
  readonly config: ServerConfig;
  readonly repository: GameRepository;
  readonly sessions: SessionStore;
  readonly limiter: RateLimiter;
  readonly now?: () => number;
  readonly trustedProxyHops?: number;
}

export interface GameApi {
  action(request: Request): Promise<Response>;
  gameState(request: Request): Promise<Response>;
}

function jsonWithHeaders(data: unknown, status: number, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}

function rateLimited(result: RateLimitResult): Response {
  return jsonWithHeaders(
    { error: "Too many requests, please try again later", retryAfterSeconds: result.retryAfterSeconds },
    429,
    { "retry-after": String(result.retryAfterSeconds) },
  );
}

export function createGameApi(deps: GameApiDependencies): GameApi {
  const now = deps.now ?? Date.now;
  const trustedProxyHops = deps.trustedProxyHops ?? 0;

  async function checkLimit(
    kind: RateLimitKind,
    subject?: string | null,
    clientIp?: string | null,
  ): Promise<Response | null> {
    const result = await deps.limiter.check({ kind, subject, clientIp });
    return result.allowed ? null : rateLimited(result);
  }

  async function requireSession(request: Request) {
    const token = readSessionToken(request.headers.get("cookie"));
    const session = await resolveSession(deps.sessions, token);
    if (!session) throw new UnauthorizedError();
    return session;
  }

  async function discardNewSession(token: string, wasExisting: boolean): Promise<void> {
    if (wasExisting) return;
    await deps.sessions.delete(hashSessionToken(token)).catch(() => undefined);
  }

  async function action(request: Request): Promise<Response> {
    try {
      checkMutationOrigin(request, deps.config);
      const input = parseActionInput(await readJsonBody(request));
      const token = readSessionToken(request.headers.get("cookie"));

      if (input.action === "host") {
        const clientIp = readTrustedClientIp(request.headers, { trustedProxyHops });
        const creationLimit = await checkLimit("create", null, clientIp);
        if (creationLimit) return creationLimit;

        const existing = await resolveSession(deps.sessions, token);
        const session = await reuseOrCreateSession(deps.sessions, deps.config, token, now);
        try {
          const hostLimit = await checkLimit("host", session.playerId);
          if (hostLimit) {
            await discardNewSession(session.token, existing !== null);
            return hostLimit;
          }
          const state = await deps.repository.createGame({
            hostPlayerId: session.playerId,
            hostName: input.name,
          });
          return jsonWithHeaders(toPublicState(state, session.playerId), 200, {
            "set-cookie": sessionCookie(deps.config, session.token),
          });
        } catch (error: unknown) {
          await discardNewSession(session.token, existing !== null);
          throw error;
        }
      }

      if (input.action === "join") {
        const existing = await resolveSession(deps.sessions, token);
        if (!existing) {
          const clientIp = readTrustedClientIp(request.headers, { trustedProxyHops });
          const bootstrapLimit = await checkLimit("create", null, clientIp);
          if (bootstrapLimit) return bootstrapLimit;
        }
        const session = await reuseOrCreateSession(deps.sessions, deps.config, token, now);
        try {
          const joinLimit = await checkLimit("join", session.playerId);
          if (joinLimit) {
            await discardNewSession(session.token, existing !== null);
            return joinLimit;
          }
          const state = await deps.repository.updateGame(input.roomId, (current) =>
            applyGameAction(current, { type: "join", name: input.name }, session.playerId, now()),
          );
          return jsonWithHeaders(toPublicState(state, session.playerId), 200, {
            "set-cookie": sessionCookie(deps.config, session.token),
          });
        } catch (error: unknown) {
          await discardNewSession(session.token, existing !== null);
          throw error;
        }
      }

      const session = await requireSession(request);
      const actionLimit = await checkLimit("action", session.playerId);
      if (actionLimit) return actionLimit;
      const roomId = input.roomId;
      const engineAction = toEngineAction(input);
      let selectedCardId: string | undefined;
      const state = await deps.repository.updateGame(roomId, (current) => {
        let actionForAttempt = engineAction;
        if (engineAction.type === "reveal-player") {
          if (selectedCardId === undefined) {
            const target = current.players.find(
              (player) => player.id === engineAction.targetPlayerId,
            );
            selectedCardId = target
              ? findUnrevealedCardId(target.hand, engineAction.minMax)
              : undefined;
          }
          actionForAttempt = { ...engineAction, selectedCardId };
        }
        return applyGameAction(current, actionForAttempt, session.playerId, now());
      });
      return jsonNoStore(toPublicState(state, session.playerId));
    } catch (error: unknown) {
      return toErrorResponse(error);
    }
  }

  async function gameState(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.searchParams.has("playerId")) {
        throw new ApiError(400, "Legacy player identity is not accepted");
      }
      const roomId = validateRoomId(url.searchParams.get("id"));
      const session = await requireSession(request);
      const pollLimit = await checkLimit("poll", session.playerId);
      if (pollLimit) return pollLimit;
      const state = await deps.repository.pollGame(roomId, session.playerId, now());
      if (!state) throw new NotFoundError("Game not found");
      return jsonNoStore(toPublicState(state, session.playerId));
    } catch (error: unknown) {
      return toErrorResponse(error);
    }
  }

  return { action, gameState };
}

function toEngineAction(input: Exclude<ActionRequest, { action: "host" | "join" }>): GameAction {
  switch (input.action) {
    case "start":
      return { type: "start" };
    case "reveal-public":
      return { type: "reveal-public", cardId: input.cardId };
    case "reveal-player":
      return { type: "reveal-player", targetPlayerId: input.targetPlayerId, minMax: input.minMax };
    case "chat":
      return { type: "chat", message: input.message };
  }
}
