import { randomInt } from "node:crypto";
import { WatchError } from "redis";
import type { ServerState } from "@/types";
import { getRedis, createIsolatedConnection } from "@/lib/redis";
import {
  ConflictError,
  SETTLE_DELAY_MS,
  createGameState,
  settleIfOverdue,
} from "./game-engine";
import { ForbiddenError, NotFoundError, storageFailure } from "./errors";
import { CARD_ID_PATTERN, PLAYER_ID_PATTERN, ROOM_ID_PATTERN } from "./validation";

/**
 * Atomic game store.
 *
 * The legacy implementation read a room, mutated the parsed object in place
 * and wrote it back with a plain `SET`, which lost concurrent updates and
 * dropped the expiry. This repository stores every room as one JSON document
 * behind an optimistic transaction:
 *
 * - `createGame` uses `SET key value NX EX <ttl>`, so an existing room is
 *   never overwritten and the room always carries an idle expiry.
 * - `updateGame` watches the room key, reads the current state, applies the
 *   transition to a clone and writes the result with `EX <ttl>` inside the
 *   same transaction. A conflicting write is retried at most
 *   {@link MAX_UPDATE_RETRIES} times (six attempts in total) and then
 *   reported as a 409.
 * - `readGame` is a pure read: it never rewrites the document and never
 *   extends the idle expiry.
 * - Settlement runs through `updateGame`, so there is exactly one write path
 *   for game state.
 *
 * The repository is described by the {@link GameRepository} interface so
 * unit tests can substitute a fake without touching Redis.
 */

/** Idle expiry of a room, in seconds. */
export const GAME_TTL_SECONDS = 60 * 60;
/** Newest chat messages kept in a room. */
export const MAX_CHAT_MESSAGES = 100;
/** Attempts allowed to mint a non-colliding room id. */
export const MAX_ROOM_ID_ATTEMPTS = 5;
/**
 * Retries allowed after the first attempt when the watched transaction
 * conflicts with a concurrent write.
 *
 * The plan budgets "retry conflicts at most five times, then return 409",
 * so an update makes at most one initial attempt plus five retries before
 * the conflict is reported to the caller.
 */
export const MAX_UPDATE_RETRIES = 5;
/**
 * Total attempts of one update: the initial attempt plus the retries.
 *
 * `MAX_UPDATE_ATTEMPTS - 1` retries are performed, so a conflicting update
 * is attempted at most `MAX_UPDATE_ATTEMPTS` times and then reported as a
 * 409 conflict.
 */
export const MAX_UPDATE_ATTEMPTS = MAX_UPDATE_RETRIES + 1;
/** Length of a generated room id. */
export const ROOM_ID_LENGTH = 10;

const ROOM_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Mints a cryptographically random room id.
 *
 * `randomInt` draws from the system CSPRNG, and the alphabet matches
 * {@link ROOM_ID_PATTERN}, so the id can be handed to a client and validated
 * with the very same pattern.
 */
export function generateRoomId(length: number = ROOM_ID_LENGTH): string {
  let id = "";
  for (let index = 0; index < length; index += 1) {
    id += ROOM_ID_ALPHABET[randomInt(0, ROOM_ID_ALPHABET.length)];
  }
  return id;
}

export interface CreateGameInput {
  readonly hostPlayerId: string;
  readonly hostName: string;
}

/**
 * A transition applied to the current state of a room.
 *
 * The transition receives a clone and returns the next state. It may be
 * asynchronous: the repository awaits the result and validates its shape
 * before anything is written. It must not mutate anything outside the
 * clone and must throw an `ApiError` to reject the change.
 */
export type GameTransition = (state: ServerState) => ServerState | Promise<ServerState>;

/**
 * Storage contract for game rooms.
 *
 * The route layer only depends on this interface, so a fake implementation
 * is enough for unit tests.
 */
export interface GameRepository {
  /** Creates a new room. An existing room is never overwritten. */
  createGame(input: CreateGameInput): Promise<ServerState>;
  /** Reads a room without writing anything. */
  readGame(roomId: string): Promise<ServerState | null>;
  /** Applies a transition atomically and returns the new state. */
  updateGame(roomId: string, transition: GameTransition): Promise<ServerState>;
  /**
   * Reads a room and settles an overdue round through {@link updateGame}.
   *
   * A read that has nothing to settle never writes and never extends the
   * idle expiry.
   */
  pollGame(roomId: string, playerId: string, now?: number): Promise<ServerState | null>;
}

export interface GameRepositoryOptions {
  /** Prefix for every key, used to isolate one deployment or test run. */
  readonly keyPrefix?: string;
  /** Idle expiry of a room in seconds. */
  readonly ttlSeconds?: number;
  /** Clock used for the state timestamps. */
  readonly now?: () => number;
  /** Room id generator; overridable for deterministic tests. */
  readonly generateRoomId?: () => string;
  /** Attempts allowed to mint a non-colliding room id. */
  readonly maxRoomIdAttempts?: number;
  /** Attempts allowed to settle a conflicting transaction. */
  readonly maxUpdateAttempts?: number;
}

/**
 * Serializes a value with sorted object keys.
 *
 * Two states are equal when their canonical forms match, which makes the
 * "nothing changed" check independent of key order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function parseState(raw: string): ServerState {
  try {
    return JSON.parse(raw) as ServerState;
  } catch {
    // A corrupt document is a storage problem, not a client problem.
    throw storageFailure();
  }
}

/**
 * Checks that a transition produced something that can be stored as a room.
 *
 * A transition that returns `undefined`, an unawaited promise, or any other
 * unexpected shape must never reach Redis: writing it would replace the room
 * with a broken document.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCard(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    (value.id === "" || (typeof value.id === "string" && CARD_ID_PATTERN.test(value.id))) &&
    Number.isInteger(value.number) &&
    Number(value.number) >= 1 &&
    Number(value.number) <= 12 &&
    typeof value.isRevealed === "boolean"
  );
}

function isPlayer(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    PLAYER_ID_PATTERN.test(value.id) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 40 &&
    Number.isSafeInteger(value.seat) &&
    Number(value.seat) >= 1 &&
    (value.isHost === undefined || typeof value.isHost === "boolean") &&
    (value.isWinner === undefined || typeof value.isWinner === "boolean") &&
    (value.isPlaying === undefined || typeof value.isPlaying === "boolean") &&
    Array.isArray(value.hand) &&
    value.hand.every(isCard) &&
    Array.isArray(value.collection) &&
    value.collection.every(isCard)
  );
}

function isMessage(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.playerName === "string" &&
    value.playerName.length > 0 &&
    value.playerName.length <= 40 &&
    Number.isFinite(value.timestamp) &&
    typeof value.content === "string" &&
    value.content.length > 0 &&
    value.content.length <= 500
  );
}

function isOptionalCardArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isCard));
}

function isGameState(value: unknown): value is ServerState {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.gameId === "string" &&
    ROOM_ID_PATTERN.test(value.gameId) &&
    (value.gameStage === "stage:lobby" ||
      value.gameStage === "stage:in-game" ||
      value.gameStage === "stage:game-over") &&
    (value.gameSubStage === undefined ||
      value.gameSubStage === null ||
      value.gameSubStage === "sub:playing" ||
      value.gameSubStage === "sub:settling") &&
    Number.isFinite(value.timestamp) &&
    Array.isArray(value.players) &&
    value.players.every(isPlayer) &&
    isOptionalCardArray(value.cardDeck) &&
    isOptionalCardArray(value.publicCards) &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage)
  );
}

/**
 * Keeps only the newest {@link MAX_CHAT_MESSAGES} messages.
 *
 * The engine stores the newest message first, so the head of the array is
 * the newest window of the conversation.
 */
function boundChat(state: ServerState): ServerState {
  const messages = state.messages ?? [];
  if (messages.length <= MAX_CHAT_MESSAGES) return state;
  return { ...state, messages: messages.slice(0, MAX_CHAT_MESSAGES) };
}

/**
 * A `WATCH` conflict: the watched key changed while the transaction was
 * being prepared. The transaction has to be retried against the new state.
 *
 * node-redis reports the conflict by rejecting `EXEC` with a `WatchError`.
 * The name is checked as well, because the error class does not set one.
 */
function isWatchConflict(error: unknown): boolean {
  if (error instanceof WatchError) return true;
  return error instanceof Error && error.name === "WatchError";
}

/**
 * Redis-backed implementation of {@link GameRepository}.
 */
export class RedisGameRepository implements GameRepository {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly now: () => number;
  private readonly generateRoomId: () => string;
  private readonly maxRoomIdAttempts: number;
  private readonly maxUpdateAttempts: number;

  constructor(options: GameRepositoryOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? "";
    this.ttlSeconds = options.ttlSeconds ?? GAME_TTL_SECONDS;
    this.now = options.now ?? (() => Date.now());
    this.generateRoomId = options.generateRoomId ?? (() => generateRoomId());
    this.maxRoomIdAttempts = options.maxRoomIdAttempts ?? MAX_ROOM_ID_ATTEMPTS;
    this.maxUpdateAttempts = options.maxUpdateAttempts ?? MAX_UPDATE_ATTEMPTS;
  }

  /**
   * The Redis key of a room.
   *
   * The room id is validated first, so a malformed id can never turn into
   * an arbitrary key.
   */
  private gameKey(roomId: string): string {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new NotFoundError("Game not found");
    }
    return `${this.keyPrefix}game:${roomId}`;
  }

  async createGame(input: CreateGameInput): Promise<ServerState> {
    const client = await getRedis();

    for (let attempt = 0; attempt < this.maxRoomIdAttempts; attempt += 1) {
      const roomId = this.generateRoomId();
      if (!ROOM_ID_PATTERN.test(roomId)) {
        throw new Error("Generated room id does not match the room id format");
      }
      const state = createGameState(roomId, input.hostPlayerId, input.hostName, this.now());
      // `NX` makes the creation atomic: an existing room is never
      // overwritten, the write simply fails and a new id is minted.
      const created = await client.set(this.gameKey(roomId), JSON.stringify(state), {
        expiration: { type: "EX", value: this.ttlSeconds },
        condition: "NX",
      });
      if (created === "OK") return state;
    }

    throw new ConflictError("Could not allocate a room, please try again");
  }

  async readGame(roomId: string): Promise<ServerState | null> {
    const client = await getRedis();
    const raw = await client.get(this.gameKey(roomId));
    if (raw === null) return null;
    return parseState(raw);
  }

  async updateGame(roomId: string, transition: GameTransition): Promise<ServerState> {
    const key = this.gameKey(roomId);

    for (let attempt = 0; attempt < this.maxUpdateAttempts; attempt += 1) {
      // A watched key belongs to one connection, so every attempt uses an
      // isolated connection that is released again below.
      const connection = await createIsolatedConnection();
      try {
        await connection.client.watch(key);
        const raw = await connection.client.get(key);
        if (raw === null) throw new NotFoundError("Game not found");

        const current = parseState(raw);
        // The transition may be asynchronous; awaiting it here keeps a
        // promise from being serialized as an empty document.
        const next = await transition(structuredClone(current));
        if (!isGameState(next)) {
          throw new Error("A game transition must return the next game state");
        }
        const bounded = boundChat(next);

        if (canonicalJson(bounded) === canonicalJson(current)) {
          // Nothing changed: skip the write so a read-only poll neither
          // rewrites the document nor extends its idle expiry.
          return current;
        }

        await connection.client
          .multi()
          .set(key, JSON.stringify(bounded), {
            expiration: { type: "EX", value: this.ttlSeconds },
          })
          .exec();
        return bounded;
      } catch (error: unknown) {
        if (isWatchConflict(error)) {
          // Somebody else changed the room: read it again and retry.
          continue;
        }
        throw error;
      } finally {
        await connection.release();
      }
    }

    throw new ConflictError("The game state changed, please try again");
  }

  async pollGame(
    roomId: string,
    playerId: string,
    now: number = this.now(),
  ): Promise<ServerState | null> {
    const state = await this.readGame(roomId);
    if (!state) return null;
    if (!state.players.some((player) => player.id === playerId)) {
      throw new ForbiddenError("You are not in this game");
    }
    if (state.gameStage !== "stage:in-game" || state.gameSubStage !== "sub:settling") {
      return state;
    }
    if (now - state.timestamp <= SETTLE_DELAY_MS) {
      return state;
    }
    // Settlement goes through the same transaction path as every other
    // change, so it happens exactly once even when several players poll at
    // the same time.
    return this.updateGame(roomId, (current) => settleIfOverdue(current, playerId, now));
  }
}
