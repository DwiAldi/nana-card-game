import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type RedisClientType } from "redis";
import { closeRedis } from "@/lib/redis";
import { RedisGameRepository } from "@/lib/server/game-repository";
import {
  ConflictError,
  SETTLE_DELAY_MS,
  applyGameAction,
  type GameEngineDeps,
} from "@/lib/server/game-engine";
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
    await sleep(1_200);

    const read = await repository.readGame(roomId);
    expect(read?.gameId).toBe(roomId);
    const polled = await repository.pollGame(roomId, HOST_ID, T0);
    expect(polled?.gameId).toBe(roomId);

    const ttlAfter = await ttlOf(roomId);
    expect(ttlAfter).toBeGreaterThan(0);
    // Reading must never refresh the expiry, so the remaining time can only
    // have shrunk.
    expect(ttlAfter).toBeLessThan(ttlBefore);
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
});
