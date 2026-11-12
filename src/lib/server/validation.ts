import { BadRequestError } from "./errors";

/**
 * Action input validation.
 *
 * The client speaks a flat, strictly-typed action protocol. Every request is
 * parsed into the discriminated {@link ActionRequest} union below; unknown
 * action names, unknown properties (including the legacy client-supplied
 * acting identity fields `playerId`, `data` and `gameId`), and malformed
 * identifiers are rejected before any storage access.
 */

export const MAX_PLAYER_NAME_LENGTH = 40;
export const MAX_CHAT_MESSAGE_LENGTH = 500;
export const MAX_BODY_BYTES = 8192;

export type MinMax = "min" | "max";

export type ActionRequest =
  | { action: "host"; name: string }
  | { action: "join"; roomId: string; name: string }
  | { action: "start"; roomId: string }
  | { action: "reveal-public"; roomId: string; cardId: string }
  | {
      action: "reveal-player";
      roomId: string;
      targetPlayerId: string;
      minMax: MinMax;
    }
  | { action: "chat"; roomId: string; message: string };

/** Room ids: bounded ASCII, currently base36 timestamps joined client-side. */
const ROOM_ID_PATTERN = /^[a-z0-9]{4,32}$/;
/** Card ids follow the shipped deck, e.g. "1-a" .. "12-c". */
const CARD_ID_PATTERN = /^(1[0-2]|[1-9])-[a-z]$/;
/** Player ids are 128-bit hex values minted by the server. */
const PLAYER_ID_PATTERN = /^[a-f0-9]{32}$/;

function requireObject(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new BadRequestError("Malformed request");
  return value;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new BadRequestError("Request contains unknown fields");
    }
  }
}

function requireFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  rejectUnknownKeys(body, allowed);
  for (const field of allowed.filter((name) => name !== "action")) {
    if (body[field] === undefined) {
      throw new BadRequestError("Malformed request");
    }
  }
}

function validatePattern(value: string, pattern: RegExp, message: string): string {
  if (!pattern.test(value)) throw new BadRequestError(message);
  return value;
}

export function validatePlayerName(value: unknown): string {
  if (typeof value !== "string") throw new BadRequestError("Player name must be text");
  const name = value.trim();
  if (name.length === 0) throw new BadRequestError("Player name is required");
  if (name.length > MAX_PLAYER_NAME_LENGTH) {
    throw new BadRequestError(`Player name must be at most ${MAX_PLAYER_NAME_LENGTH} characters`);
  }
  return name;
}

export function validateChatMessage(value: unknown): string {
  if (typeof value !== "string") throw new BadRequestError("Message must be text");
  const message = value.trim();
  if (message.length === 0) throw new BadRequestError("Message is required");
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new BadRequestError(`Message must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters`);
  }
  return message;
}

export function validateRoomId(value: unknown): string {
  return validatePattern(requireString(value), ROOM_ID_PATTERN, "Invalid room ID");
}

export function validateCardId(value: unknown): string {
  return validatePattern(requireString(value), CARD_ID_PATTERN, "Invalid card ID");
}

export function validateTargetPlayerId(value: unknown): string {
  return validatePattern(requireString(value), PLAYER_ID_PATTERN, "Invalid player ID");
}

export function validateMinMax(value: unknown): MinMax {
  if (value !== "min" && value !== "max") {
    throw new BadRequestError("Invalid min/max choice");
  }
  return value;
}

export function parseActionInput(body: unknown): ActionRequest {
  const input = requireObject(body);
  const action = requireString(input.action);

  switch (action) {
    case "host": {
      requireFields(input, ["action", "name"]);
      return { action, name: validatePlayerName(input.name) };
    }
    case "join": {
      requireFields(input, ["action", "roomId", "name"]);
      return {
        action,
        roomId: validateRoomId(input.roomId),
        name: validatePlayerName(input.name),
      };
    }
    case "start": {
      requireFields(input, ["action", "roomId"]);
      return { action, roomId: validateRoomId(input.roomId) };
    }
    case "reveal-public": {
      requireFields(input, ["action", "roomId", "cardId"]);
      return {
        action,
        roomId: validateRoomId(input.roomId),
        cardId: validateCardId(input.cardId),
      };
    }
    case "reveal-player": {
      requireFields(input, ["action", "roomId", "targetPlayerId", "minMax"]);
      return {
        action,
        roomId: validateRoomId(input.roomId),
        targetPlayerId: validateTargetPlayerId(input.targetPlayerId),
        minMax: validateMinMax(input.minMax),
      };
    }
    case "chat": {
      requireFields(input, ["action", "roomId", "message"]);
      return {
        action,
        roomId: validateRoomId(input.roomId),
        message: validateChatMessage(input.message),
      };
    }
    default:
      throw new BadRequestError("Unknown action");
  }
}
