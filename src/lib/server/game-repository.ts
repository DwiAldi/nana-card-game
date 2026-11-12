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
import { ROOM_ID_PATTERN } from "./validation";

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
 *   same transaction. A conflicting write is retried a bounded number of
 *   times and then reported as a 409.
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
/** Attempts allowed to settle a conflicting transaction. */
export const MAX_UPDATE_ATTEMPTS = 5;
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
 * The transition receives a clone and returns the next state. It must not
 * mutate anything outside the clone and must throw an `ApiError` to reject
 * the change.
 */
export type GameTransition = (state: ServerState) => ServerState;

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
        const next = transition(structuredClone(current));
        if (!next || typeof next !== "object") {
          throw new Error("A game transition must return the next state");
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
