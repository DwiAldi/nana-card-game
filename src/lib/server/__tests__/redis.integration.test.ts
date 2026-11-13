import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type RedisClientType } from "redis";
import { closeRedis, createIsolatedConnection, getRedis } from "@/lib/redis";
import { RedisGameRepository } from "@/lib/server/game-repository";
import {
  ConflictError,
  SETTLE_DELAY_MS,
  applyGameAction,
  type GameEngineDeps,
} from "@/lib/server/game-engine";
import { ApiError, storageFailureMessage } from "@/lib/server/errors";
import { ROOM_ID_PATTERN } from "@/lib/server/validation";
import type { ServerState } from "@/types";

/**
 * Redis integration tests.
 *
 * The suite runs against a real Redis instance and is gated on
 * `TEST_REDIS_URL`. Without it the whole suite is skipped with an explicit
 * message: a missing disposable Redis must never silently turn into a
 * passing run, and the suite must never touch an unspecified database.
 *
 * Every key this suite creates lives under a per-run prefix
 * (`nana-itest:<run id>:`) and only those keys are deleted afterwards.
 */

/** A disposable Redis URL. Absent means "skip", never "use the default". */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL?.trim() ?? "";
const hasTestRedis = TEST_REDIS_URL.length > 0;

if (!hasTestRedis) {
  it.skip(
    "Redis integration suite skipped: set TEST_REDIS_URL to a disposable Redis instance",
    () => {
      // Intentionally empty: the skip reason is the test title.
    },
  );
}

const describeWithRedis = hasTestRedis ? describe : describe.skip;

/** Unique per run, so two concurrent runs never share a key space. */
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const KEY_PREFIX = `nana-itest:${RUN_ID}:`;

const HOST_ID = "a1".repeat(16);
const GUEST_ID = "b2".repeat(16);
const THIRD_ID = "c3".repeat(16);
const FOURTH_ID = "d4".repeat(16);

/** A fixed clock: every transition in this suite is time-controlled. */
const T0 = 1_700_000_000_000;

/**
 * Deterministic deck: opaque, ascending card ids and no shuffling, so the
 * dealt hands are known exactly (two players: 1,1,1,2,2,2,3,3,3,4 for the
 * host and 4,4,5,5,5,6,6,6,7,7 for the guest).
 */
const deterministicDeps: GameEngineDeps = {
  generateCardId: (() => {
    let counter = 0;
    return () => (counter++).toString(16).padStart(24, "0");
  })(),
  shuffle: (items) => [...items],
};

let admin: RedisClientType;
let repository: RedisGameRepository;

const gameKey = (roomId: string): string => `${KEY_PREFIX}game:${roomId}`;

const ttlOf = (roomId: string): Promise<number> => admin.pTTL(gameKey(roomId));

async function waitForTtlAtMost(
  roomId: string,
  maximum: number,
  deadlineMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  let ttl = await ttlOf(roomId);
  while (ttl > maximum && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    ttl = await ttlOf(roomId);
  }
  if (ttl > maximum) throw new Error("Redis TTL did not decrease before the deadline");
  return ttl;
}

const revealedCards = (state: ServerState | null) =>
  (state?.players ?? []).flatMap((player) => player.hand).filter((card) => card.isRevealed);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(async () => {
  if (!hasTestRedis) return;
  // The server modules read REDIS_URL; the disposable instance is injected
  // through it so no production configuration is touched.
  vi.stubEnv("REDIS_URL", TEST_REDIS_URL);
  admin = createClient({
    url: TEST_REDIS_URL,
    socket: { connectTimeout: 5_000, reconnectStrategy: () => false },
  });
  admin.on("error", () => {
    // The suite asserts on failures explicitly; an unhandled error event
    // would crash the worker.
  });
  await admin.connect();
  repository = new RedisGameRepository({ keyPrefix: KEY_PREFIX, now: () => T0 });
});

afterAll(async () => {
  if (!hasTestRedis) return;
  // Delete only the keys this run created. `scanIterator` yields one batch
  // of keys per iteration.
  const keys: string[] = [];
  for await (const batch of admin.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 200 })) {
    keys.push(...batch);
  }
  if (keys.length > 0) await admin.del(keys);
  await admin.close();
  await closeRedis();
  vi.unstubAllEnvs();
});

describeWithRedis("redis game repository", () => {
  it("does not mark the shared client terminal when an isolated reconnect exhausts", async () => {
    const shared = await getRedis();
    const isolated = await createIsolatedConnection();
    try {
      const reconnectStrategy = isolated.client.options.socket?.reconnectStrategy;
      expect(typeof reconnectStrategy).toBe("function");
      if (typeof reconnectStrategy !== "function") throw new Error("Missing reconnect strategy");

      expect(reconnectStrategy(5, new Error("isolated connection failed"))).toBe(false);

      // Put the shared client into a real, temporary reconnect. If the
      // isolated strategy accidentally marked it terminal, getRedis will
      // destroy it instead of waiting for this same client to recover.
      const sharedId = await shared.clientId();
      const reconnecting = new Promise<void>((resolve) => {
        shared.once("reconnecting", resolve);
      });
      await admin.sendCommand(["CLIENT", "KILL", "ID", String(sharedId)]);
      await reconnecting;

      const sharedAfterIsolatedFailure = await getRedis();
      expect(sharedAfterIsolatedFailure).toBe(shared);
      await expect(sharedAfterIsolatedFailure.ping()).resolves.toBe("PONG");
    } finally {
      await isolated.release();
    }
  });

  const expectStorageFailure = async (operation: Promise<unknown>): Promise<void> => {
    const error = await operation.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).message).toBe(storageFailureMessage);
  };

  it("creates a room with a server-generated id that matches the room id format", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });

    expect(created.gameId).toMatch(ROOM_ID_PATTERN);
    expect(created.players).toHaveLength(1);
    expect(created.players[0]).toMatchObject({
      id: HOST_ID,
      name: "Host",
      seat: 1,
      isHost: true,
    });
    expect(created.gameStage).toBe("stage:lobby");

    const other = await repository.createGame({
      hostPlayerId: GUEST_ID,
      hostName: "Guest",
    });
    expect(other.gameId).not.toBe(created.gameId);
    expect(other.gameId).toMatch(ROOM_ID_PATTERN);
  });

  it("never overwrites an existing room", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    // A repository that always mints the same room id must never be able to
    // take over the room that already exists.
    const colliding = new RedisGameRepository({
      keyPrefix: KEY_PREFIX,
      now: () => T0,
      generateRoomId: () => roomId,
    });

    await expect(
      colliding.createGame({ hostPlayerId: GUEST_ID, hostName: "Intruder" }),
    ).rejects.toThrow(ConflictError);

    const after = await repository.readGame(roomId);
    expect(after?.players).toHaveLength(1);
    expect(after?.players[0].id).toBe(HOST_ID);
    expect(after?.players[0].name).toBe("Host");
  });

  it("keeps every player when joins race", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    const joiners = [GUEST_ID, THIRD_ID, FOURTH_ID];
    await Promise.all(
      joiners.map((playerId, index) =>
        repository.updateGame(roomId, (state) =>
          applyGameAction(state, { type: "join", name: `Guest ${index}` }, playerId, T0),
        ),
      ),
    );

    const after = await repository.readGame(roomId);
    expect(after?.players).toHaveLength(1 + joiners.length);
    expect(new Set(after?.players.map((player) => player.id)).size).toBe(
      1 + joiners.length,
    );
    expect(after?.players[0].id).toBe(HOST_ID);
    for (const playerId of joiners) {
      expect(after?.players.some((player) => player.id === playerId)).toBe(true);
    }
  });

  it("keeps a positive expiry after a mutation and refreshes the idle window", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    const ttlAfterCreate = await ttlOf(roomId);
    expect(ttlAfterCreate).toBeGreaterThan(0);
    expect(ttlAfterCreate).toBeLessThanOrEqual(3_600_000);

    await repository.updateGame(roomId, (state) =>
      applyGameAction(state, { type: "join", name: "Guest" }, GUEST_ID, T0),
    );

    const ttlAfterUpdate = await ttlOf(roomId);
    expect(ttlAfterUpdate).toBeGreaterThan(0);
    expect(ttlAfterUpdate).toBeLessThanOrEqual(3_600_000);
    // The write re-applied the full hour instead of dropping the expiry.
    expect(ttlAfterUpdate).toBeGreaterThan(3_000_000);
  });

  it("does not extend the idle expiry when the state is only read", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    const ttlBefore = await ttlOf(roomId);
    const ttlBeforeRead = await waitForTtlAtMost(roomId, ttlBefore - 800);

    const read = await repository.readGame(roomId);
    expect(read?.gameId).toBe(roomId);
    const polled = await repository.pollGame(roomId, HOST_ID, T0);
    expect(polled?.gameId).toBe(roomId);

    const ttlAfter = await ttlOf(roomId);
    expect(ttlAfter).toBeGreaterThan(0);
    // Reading must never refresh the expiry, so the remaining time can only
    // have shrunk from the value immediately before the reads.
    expect(ttlAfter).toBeLessThanOrEqual(ttlBeforeRead);
  });

  it("does not write or refresh the expiry for an identical update", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;
    const ttlBefore = await ttlOf(roomId);
    const ttlBeforeUpdate = await waitForTtlAtMost(roomId, ttlBefore - 800);

    const returned = await repository.updateGame(roomId, (state) => structuredClone(state));
    expect(returned).toEqual(created);

    const ttlAfter = await ttlOf(roomId);
    expect(ttlAfter).toBeGreaterThan(0);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBeforeUpdate);
  });

  it("keeps only the newest 100 chat messages", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    await repository.updateGame(roomId, (state) => {
      let next = state;
      for (let index = 0; index < 105; index += 1) {
        next = applyGameAction(
          next,
          { type: "chat", message: `message ${index}` },
          HOST_ID,
          T0 + index,
        );
      }
      return next;
    });

    const after = await repository.readGame(roomId);
    expect(after?.messages).toHaveLength(100);
    // The engine stores the newest message first.
    expect(after?.messages[0].content).toBe("message 104");
    expect(after?.messages[99].content).toBe("message 5");
    expect(after?.messages.some((message) => message.content === "message 4")).toBe(
      false,
    );
  });

  it("keeps the newest chat messages when they are written one by one", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    await repository.updateGame(roomId, (state) =>
      applyGameAction(state, { type: "chat", message: "first" }, HOST_ID, T0),
    );
    await repository.updateGame(roomId, (state) =>
      applyGameAction(state, { type: "chat", message: "second" }, HOST_ID, T0 + 1),
    );

    const after = await repository.readGame(roomId);
    expect(after?.messages).toHaveLength(2);
    expect(after?.messages[0].content).toBe("second");
    expect(after?.messages[1].content).toBe("first");
  });

  it("settles exactly once when reveals and polls race", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    await repository.updateGame(roomId, (state) =>
      applyGameAction(
        state,
        { type: "join", name: "Guest" },
        GUEST_ID,
        T0,
        deterministicDeps,
      ),
    );
    await repository.updateGame(roomId, (state) =>
      applyGameAction(state, { type: "start" }, HOST_ID, T0, deterministicDeps),
    );

    // The host reveals the lowest card of their own hand (a 1).
    await repository.updateGame(roomId, (state) =>
      applyGameAction(
        state,
        { type: "reveal-player", targetPlayerId: HOST_ID, minMax: "min" },
        HOST_ID,
        T0,
        deterministicDeps,
      ),
    );

    // Two reveals race for the two remaining 1s.
    await Promise.all([
      repository.updateGame(roomId, (state) =>
        applyGameAction(
          state,
          { type: "reveal-player", targetPlayerId: HOST_ID, minMax: "min" },
          HOST_ID,
          T0,
          deterministicDeps,
        ),
      ),
      repository.updateGame(roomId, (state) =>
        applyGameAction(
          state,
          { type: "reveal-player", targetPlayerId: HOST_ID, minMax: "min" },
          HOST_ID,
          T0,
          deterministicDeps,
        ),
      ),
    ]);

    const afterReveals = await repository.readGame(roomId);
    expect(revealedCards(afterReveals)).toHaveLength(3);
    expect(revealedCards(afterReveals).every((card) => card.number === 1)).toBe(true);
    expect(afterReveals?.gameSubStage).toBe("sub:settling");

    // Three polls race to settle the round.
    const settleAt = T0 + SETTLE_DELAY_MS + 1;
    const settled = await Promise.all([
      repository.pollGame(roomId, HOST_ID, settleAt),
      repository.pollGame(roomId, GUEST_ID, settleAt),
      repository.pollGame(roomId, HOST_ID, settleAt),
    ]);
    expect(settled.every((state) => state !== null)).toBe(true);

    const afterSettlement = await repository.readGame(roomId);
    const host = afterSettlement?.players.find((player) => player.id === HOST_ID);
    const guest = afterSettlement?.players.find((player) => player.id === GUEST_ID);

    // The challenge is collected exactly once, never twice.
    expect(host?.collection).toHaveLength(3);
    expect(guest?.collection).toHaveLength(0);
    // The turn advanced exactly once.
    expect(afterSettlement?.players.filter((player) => player.isPlaying)).toHaveLength(1);
    expect(guest?.isPlaying).toBe(true);
    expect(host?.isPlaying).toBe(false);
    expect(afterSettlement?.gameSubStage).toBe("sub:playing");
    // The round was concealed again after the settlement.
    expect(revealedCards(afterSettlement)).toHaveLength(0);
  });

  it("rejects a transition that is not allowed and leaves the room untouched", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;
    const before = await repository.readGame(roomId);

    await expect(
      repository.updateGame(roomId, (state) =>
        applyGameAction(state, { type: "start" }, HOST_ID, T0),
      ),
    ).rejects.toThrow();

    const after = await repository.readGame(roomId);
    expect(after?.players).toHaveLength(1);
    expect(after?.gameStage).toBe("stage:lobby");
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("reports a missing room instead of creating one", async () => {
    await expect(repository.readGame("missingroom")).resolves.toBeNull();
    await expect(
      repository.updateGame("missingroom", (state) => state),
    ).rejects.toThrow();
  });

  it("retries a conflicting transaction five times and then reports a conflict", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    // Writing to the watched key from another connection makes the
    // transaction's EXEC fail with a watch conflict, so every attempt
    // conflicts. The transition also changes the state, otherwise the
    // repository skips the write and no conflict can occur.
    let attempts = 0;
    const error = await repository
      .updateGame(roomId, async (state) => {
        attempts += 1;
        const changed: ServerState = {
          ...state,
          players: state.players.map((player) => ({ ...player, name: `Host ${attempts}` })),
        };
        await admin.set(gameKey(roomId), JSON.stringify(changed));
        return changed;
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).status).toBe(409);
    // One initial attempt plus five retries.
    expect(attempts).toBe(6);
  });

  it("does not overwrite the room when a transition returns an unusable value", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;
    const before = await repository.readGame(roomId);

    await expect(
      repository.updateGame(roomId, () => ({}) as unknown as ServerState),
    ).rejects.toThrow();

    const after = await repository.readGame(roomId);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(await ttlOf(roomId)).toBeGreaterThan(0);
  });

  it("rejects a partially shaped state and preserves the stored room", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;
    const before = await repository.readGame(roomId);

    const partial = {
      gameStage: "stage:lobby",
      players: [{ id: HOST_ID }],
      publicCards: [],
      messages: [],
    };
    await expect(
      repository.updateGame(roomId, () => partial as unknown as ServerState),
    ).rejects.toThrow(/next game state/);

    expect(await repository.readGame(roomId)).toEqual(before);
  });

  it("rejects a revealed empty public-card slot and preserves the room", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    await expect(
      repository.updateGame(roomId, (state) => ({
        ...state,
        publicCards: [{ id: "", number: 1, isRevealed: true }],
      })),
    ).rejects.toThrow(/next game state/);

    expect(await repository.readGame(roomId)).toEqual(created);
  });

  it.each([
    ["an empty object", {}],
    [
      "a partial nested object",
      {
        gameId: "malformed1",
        gameStage: "stage:lobby",
        timestamp: T0,
        players: [{ id: HOST_ID }],
        messages: [],
      },
    ],
  ])("rejects stored valid JSON containing %s without overwriting it", async (_label, malformed) => {
    const roomId = `bad${Math.random().toString(36).slice(2, 10)}`;
    const raw = JSON.stringify(malformed);
    await admin.set(gameKey(roomId), raw, { expiration: { type: "EX", value: 60 } });

    await expectStorageFailure(repository.readGame(roomId));
    await expectStorageFailure(repository.updateGame(roomId, (state) => state));

    expect(await admin.get(gameKey(roomId))).toBe(raw);
  });

  it.each([
    ["changes the room id", (state: ServerState) => ({ ...state, gameId: "anotherroom" })],
    [
      "adds a top-level property",
      (state: ServerState) => ({ ...state, unexpected: true }) as ServerState,
    ],
    [
      "adds a nested property",
      (state: ServerState) => ({
        ...state,
        players: state.players.map((player, index) =>
          index === 0 ? ({ ...player, unexpected: true } as typeof player) : player,
        ),
      }),
    ],
    [
      "puts an empty-id card in a hand",
      (state: ServerState) => ({
        ...state,
        players: state.players.map((player, index) =>
          index === 0
            ? {
                ...player,
                hand: [{ id: "", number: 1, isRevealed: false }],
              }
            : player,
        ),
      }),
    ],
  ])("rejects a transition that %s and leaves the room intact", async (_label, transition) => {
    const created = await repository.createGame({ hostPlayerId: HOST_ID, hostName: "Host" });
    const rawBefore = await admin.get(gameKey(created.gameId));

    await expect(repository.updateGame(created.gameId, transition)).rejects.toThrow();

    expect(await admin.get(gameKey(created.gameId))).toBe(rawBefore);
  });

  it("rejects a cyclic transition result without overflowing and leaves the room intact", async () => {
    const created = await repository.createGame({ hostPlayerId: HOST_ID, hostName: "Host" });
    const rawBefore = await admin.get(gameKey(created.gameId));

    await expect(
      repository.updateGame(created.gameId, (state) => {
        const cyclic = state as ServerState & { cycle?: unknown };
        cyclic.cycle = cyclic;
        return cyclic;
      }),
    ).rejects.toThrow();

    expect(await admin.get(gameKey(created.gameId))).toBe(rawBefore);
  });

  it("accepts an empty-id removed slot only in public cards", async () => {
    const created = await repository.createGame({ hostPlayerId: HOST_ID, hostName: "Host" });

    const updated = await repository.updateGame(created.gameId, (state) => ({
      ...state,
      publicCards: [{ id: "", number: 7, isRevealed: false }],
    }));

    expect(updated.publicCards).toEqual([{ id: "", number: 7, isRevealed: false }]);
    expect((await repository.readGame(created.gameId))?.publicCards).toEqual(updated.publicCards);
  });

  it("stores the state a transition returns when it is asynchronous", async () => {
    const created = await repository.createGame({
      hostPlayerId: HOST_ID,
      hostName: "Host",
    });
    const roomId = created.gameId;

    const updated = await repository.updateGame(roomId, async (state) => {
      await sleep(5);
      return { ...state, gameStage: "stage:in-game" as const };
    });

    expect(updated.gameStage).toBe("stage:in-game");
    const stored = await repository.readGame(roomId);
    expect(stored?.gameStage).toBe("stage:in-game");
  });
});
