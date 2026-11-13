import type { PublicGameState } from "@/types";
import type { MinMax } from "./game-helper";

export class GameApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "GameApiError";
  }
}

async function parseResponse(response: Response): Promise<PublicGameState> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const safeMessage = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "The server could not complete the request";
    const bodyRetry = body && typeof body === "object"
      ? (body as { retryAfterSeconds?: unknown }).retryAfterSeconds
      : null;
    const headerRetry = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const retryAfterSeconds = response.status === 429
      ? (typeof bodyRetry === "number" && Number.isFinite(bodyRetry)
          ? bodyRetry
          : Number.isFinite(headerRetry) ? headerRetry : null)
      : null;
    throw new GameApiError(safeMessage, response.status, retryAfterSeconds);
  }
  return body as PublicGameState;
}

async function action(payload: object): Promise<PublicGameState> {
  return parseResponse(await fetch("/api/action", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
}

export const gameApi = {
  host: (name: string) => action({ action: "host", name }),
  join: (roomId: string, name: string) => action({ action: "join", roomId, name }),
  start: (roomId: string) => action({ action: "start", roomId }),
  revealPublic: (roomId: string, cardId: string) =>
    action({ action: "reveal-public", roomId, cardId }),
  revealPlayer: (roomId: string, targetPlayerId: string, minMax: MinMax) =>
    action({ action: "reveal-player", roomId, targetPlayerId, minMax }),
  chat: (roomId: string, message: string) => action({ action: "chat", roomId, message }),
  poll: async (roomId: string) =>
    parseResponse(await fetch(`/api/game-state?id=${encodeURIComponent(roomId)}`, {
      credentials: "same-origin",
      cache: "no-store",
    })),
};
