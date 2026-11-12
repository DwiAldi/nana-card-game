import { describe, expect, it } from "vitest";
import type { Card, ServerState } from "@/types";
import { ForbiddenError } from "../errors";
import {
  ConflictError,
  MAX_PLAYERS,
  SETTLE_DELAY_MS,
  applyGameAction,
  createGameState,
  defaultGameEngineDeps,
  settleIfOverdue,
} from "../game-engine";
import type { GameEngineDeps } from "../game-engine";

const NOW = 1_700_000_000_000;

/** 32-hex-char player ids, as minted by the session layer. */
const P1 = "a1".repeat(16);
const P2 = "b2".repeat(16);
const P3 = "c3".repeat(16);
const STRANGER = "ff".repeat(16);

const card = (id: string, number: number, isRevealed = false): Card => ({
  id,
  number,
  isRevealed,
});

const snapshot = (value: unknown): string => JSON.stringify(value);

const expectUnchanged = (before: ServerState, after: ServerState): void => {
  expect(snapshot(after)).toBe(snapshot(before));
};

/** What `expect(...).toThrow(...)` accepts as an expected error. */
type ThrownMatcher = string | RegExp | Error | (new (...args: never[]) => Error);

/**
 * Asserts that `fn` throws and that the input state survives untouched.
 *
 * The snapshot is taken *before* `fn` runs and compared with a fresh
 * snapshot afterwards. Snapshotting only after the action would compare a
 * state with itself and could never fail, so the ordering here is what
 * makes the assertion meaningful.
 */
const expectInputUnchanged = (
  state: ServerState,
  fn: () => unknown,
  matcher?: ThrownMatcher,
): void => {
  const before = snapshot(state);
  if (matcher === undefined) {
    expect(fn).toThrow();
  } else {
    expect(fn).toThrow(matcher);
  }
  expect(snapshot(state)).toBe(before);
};

/**
 * Deterministic engine dependencies: sequential opaque ids and an identity
 * shuffle, so deals are reproducible (rule order: 1,1,1,2,2,2,...).
 */
const sequentialDeps: GameEngineDeps = {
  generateCardId: (() => {
    let next = 0;
    return () => `opaque-${String(++next).padStart(4, "0")}`;
  })(),
  shuffle: (items) => [...items],
};

const lobbyState = (ids: string[] = [P1]): ServerState => ({
  gameId: "roomabc123",
  gameStage: "stage:lobby",
  gameSubStage: null,
  timestamp: NOW,
  players: ids.map((id, index) => ({
    id,
    name: `Player ${index + 1}`,
    seat: index + 1,
    isHost: index === 0,
    isPlaying: false,
    isWinner: false,
    hand: [],
    collection: [],
  })),
  cardDeck: [],
  publicCards: [],
  messages: [],
});

interface InGameOptions {
  hands?: Record<string, Card[]>;
  collections?: Record<string, Card[]>;
  publicCards?: Card[];
  current?: string;
  subStage?: "sub:playing" | "sub:settling";
  timestamp?: number;
}

const inGameState = (options: InGameOptions = {}): ServerState => {
  const ids = [P1, P2, P3];
  const hands = options.hands ?? {};
  const collections = options.collections ?? {};
  return {
    gameId: "roomabc123",
    gameStage: "stage:in-game",
    gameSubStage: options.subStage ?? "sub:playing",
    timestamp: options.timestamp ?? NOW,
    players: ids.map((id, index) => ({
      id,
      name: `Player ${index + 1}`,
      seat: index + 1,
      isHost: index === 0,
      isPlaying: (options.current ?? P1) === id,
      isWinner: false,
      hand: [...(hands[id] ?? [])],
      collection: [...(collections[id] ?? [])],
    })),
    cardDeck: [],
    publicCards: options.publicCards ?? [],
    messages: [],
  };
};

describe("createGameState", () => {
  it("creates a lobby owned by the host with no cards on the table", () => {
    const state = createGameState("roomabc123", P1, "Host", NOW);
    expect(state.gameId).toBe("roomabc123");
    expect(state.gameStage).toBe("stage:lobby");
    expect(state.gameSubStage).toBeNull();
    expect(state.timestamp).toBe(NOW);
    expect(state.players).toHaveLength(1);
    expect(state.players[0]).toMatchObject({
      id: P1,
      name: "Host",
      seat: 1,
      isHost: true,
      isPlaying: false,
    });
    expect(state.cardDeck).toEqual([]);
    expect(state.publicCards).toEqual([]);
    expect(state.messages).toEqual([]);
  });
});

describe("join", () => {
  it("adds a new member with the next seat in the lobby", () => {
    const state = lobbyState([P1]);
    const next = applyGameAction(state, { type: "join", name: "Guest" }, P2, NOW + 10);
    expect(next.players).toHaveLength(2);
    expect(next.players[1]).toMatchObject({
      id: P2,
      name: "Guest",
      seat: 2,
      isHost: false,
      isPlaying: false,
    });
    expect(next.gameStage).toBe("stage:lobby");
  });

  it("returns an unchanged state when the member joins again", () => {
    const state = lobbyState([P1, P2]);
    const next = applyGameAction(state, { type: "join", name: "Ignored" }, P1, NOW + 10);
    expectUnchanged(state, next);
  });

  it("rejects a join once the game has started", () => {
    const state = inGameState();
    expect(() =>
      applyGameAction(state, { type: "join", name: "Late" }, STRANGER, NOW),
    ).toThrow(ConflictError);
  });

  it("rejects a join after game over", () => {
    const state = { ...inGameState(), gameStage: "stage:game-over" as const, gameSubStage: null };
    expect(() =>
      applyGameAction(state, { type: "join", name: "Late" }, STRANGER, NOW),
    ).toThrow(ConflictError);
  });

  it("rejects a join when the room is full", () => {
    const ids = ["1".repeat(16), "2".repeat(16), "3".repeat(16), "4".repeat(16), "5".repeat(16), "6".repeat(16)];
    expect(ids).toHaveLength(MAX_PLAYERS);
    const state = lobbyState(ids);
    expect(() =>
      applyGameAction(state, { type: "join", name: "One Too Many" }, STRANGER, NOW),
    ).toThrow(ConflictError);
  });
});

describe("start", () => {
  const startedThreePlayer = (() => {
    let state = lobbyState([P1]);
    state = applyGameAction(state, { type: "join", name: "Two" }, P2, NOW, sequentialDeps);
    state = applyGameAction(state, { type: "join", name: "Three" }, P3, NOW, sequentialDeps);
    return applyGameAction(state, { type: "start" }, P1, NOW, sequentialDeps);
  })();

  it("deals opaque, hidden, value-sorted hands and public cards for three players", () => {
    expect(startedThreePlayer.gameStage).toBe("stage:in-game");
    expect(startedThreePlayer.gameSubStage).toBe("sub:playing");
    expect(startedThreePlayer.cardDeck).toEqual([]);

    const hands = startedThreePlayer.players.map((p) => p.hand);
    for (const hand of hands) {
      expect(hand).toHaveLength(8);
      for (const dealt of hand) {
        expect(dealt.isRevealed).toBe(false);
        // Opaque ids must never encode the card value.
        expect(dealt.id).toMatch(/^opaque-\d{4}$/);
      }
      // Hands are sorted by numeric value, never by opaque id.
      for (let i = 1; i < hand.length; i++) {
        expect(hand[i - 1].number).toBeLessThanOrEqual(hand[i].number);
      }
    }
    expect(startedThreePlayer.publicCards).toHaveLength(9);
    for (const dealt of startedThreePlayer.publicCards ?? []) {
      expect(dealt.isRevealed).toBe(false);
      expect(dealt.id).toMatch(/^opaque-\d{4}$/);
    }

    // Three-player deck: numbers 1..11, three copies each, exactly.
    const numbers = [
      ...hands.flat(),
      ...(startedThreePlayer.publicCards ?? []),
    ].map((c) => c.number);
    numbers.sort((a, b) => a - b);
    expect(numbers).toEqual(
      Array.from({ length: 11 }, (_, i) => i + 1).flatMap((n) => [n, n, n]),
    );
  });

  it("makes the starting host the current player", () => {
    expect(startedThreePlayer.players.map((p) => p.isPlaying)).toEqual([true, false, false]);
  });

  it("deals reduced decks for two and six players", () => {
    // Two players: numbers 1..10 only, 10 hand cards + 10 public cards.
    let twoState = lobbyState([P1]);
    twoState = applyGameAction(twoState, { type: "join", name: "Two" }, P2, NOW);
    const startedTwo = applyGameAction(twoState, { type: "start" }, P1, NOW);
    expect(startedTwo.players.map((p) => p.hand.length)).toEqual([10, 10]);
    expect(startedTwo.publicCards).toHaveLength(10);
    const twoNumbers = [
      ...startedTwo.players.flatMap((p) => p.hand),
      ...(startedTwo.publicCards ?? []),
    ].map((c) => c.number);
    expect(new Set(twoNumbers)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    // Six players: full deck, 5 hand cards + 6 public cards.
    let sixState = lobbyState([P1]);
    for (const id of [P2, P3, "4".repeat(16), "5".repeat(16), "6".repeat(16)]) {
      sixState = applyGameAction(sixState, { type: "join", name: `P${id[0]}` }, id, NOW);
    }
    const startedSix = applyGameAction(sixState, { type: "start" }, P1, NOW);
    expect(startedSix.players.map((p) => p.hand.length)).toEqual([5, 5, 5, 5, 5, 5]);
    expect(startedSix.publicCards).toHaveLength(6);
    const sixNumbers = [
      ...startedSix.players.flatMap((p) => p.hand),
      ...(startedSix.publicCards ?? []),
    ].map((c) => c.number);
    expect(new Set(sixNumbers)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  });

  it("rejects a start by a non-host member", () => {
    const state = lobbyState([P1, P2]);
    expectInputUnchanged(
      state,
      () => applyGameAction(state, { type: "start" }, P2, NOW),
      ForbiddenError,
    );
  });

  it("rejects a start with fewer than two players", () => {
    const state = lobbyState([P1]);
    expect(() => applyGameAction(state, { type: "start" }, P1, NOW)).toThrow(ConflictError);
  });

  it("rejects starting an already started game", () => {
    const state = inGameState();
    expect(() => applyGameAction(state, { type: "start" }, P1, NOW)).toThrow(ConflictError);
  });

  it("does not mutate the input state", () => {
    const state = lobbyState([P1, P2]);
    const before = snapshot(state);
    applyGameAction(state, { type: "start" }, P1, NOW);
    expect(snapshot(state)).toBe(before);
  });
});

describe("authorization", () => {
  it("rejects every mutation by a non-member without changing state", () => {
    const lobby = lobbyState([P1, P2]);
    for (const action of [
      { type: "start" } as const,
      { type: "chat", message: "hello" } as const,
      { type: "reveal-public", cardId: "p1" } as const,
      { type: "reveal-player", targetPlayerId: P2, minMax: "min" } as const,
    ]) {
      expectInputUnchanged(
        lobby,
        () => applyGameAction(lobby, action, STRANGER, NOW),
        /not in this game/,
      );
    }

    const playing = inGameState({
      hands: { [P2]: [card("c1", 3)] },
      publicCards: [card("p1", 4)],
    });
    for (const action of [
      { type: "reveal-public", cardId: "p1" } as const,
      { type: "reveal-player", targetPlayerId: P2, minMax: "min" } as const,
      { type: "chat", message: "hello" } as const,
      { type: "start" } as const,
    ]) {
      expectInputUnchanged(
        playing,
        () => applyGameAction(playing, action, STRANGER, NOW),
        /not in this game/,
      );
    }
  });
});

describe("reveal-public", () => {
  const base = () =>
    inGameState({
      hands: { [P1]: [card("h1", 5)] },
      publicCards: [card("p1", 4), card("p2", 6)],
    });

  it("lets the current player reveal one hidden public card", () => {
    const next = applyGameAction(base(), { type: "reveal-public", cardId: "p1" }, P1, NOW + 5);
    const publicCards = next.publicCards ?? [];
    expect(publicCards[0].isRevealed).toBe(true);
    expect(publicCards[1].isRevealed).toBe(false);
    expect(next.gameSubStage).toBe("sub:playing");
    expect(next.timestamp).toBe(NOW);
  });

  it("reveals a card from a player hand and keeps the current player on mismatch", () => {
    const state = inGameState({
      hands: { [P2]: [card("a", 9), card("b", 2)] },
      publicCards: [card("p1", 5)],
    });
    const next = applyGameAction(
      state,
      { type: "reveal-player", targetPlayerId: P2, minMax: "min" },
      P1,
      NOW,
    );
    // Min is by numeric value (2), never by opaque id ("a" = 9).
    const revealed = next.players[1].hand.filter((c) => c.isRevealed);
    expect(revealed).toHaveLength(1);
    expect(revealed[0].number).toBe(2);
    expect(next.gameSubStage).toBe("sub:playing");
  });

  it("sorts min and max by numeric value, never by opaque id", () => {
    const state = inGameState({
      hands: { [P2]: [card("aaa", 9), card("zzz", 2)] },
    });
    const minReveal = applyGameAction(
      state,
      { type: "reveal-player", targetPlayerId: P2, minMax: "min" },
      P1,
      NOW,
    );
    expect(minReveal.players[1].hand.find((c) => c.isRevealed)?.number).toBe(2);

    const maxReveal = applyGameAction(
      state,
      { type: "reveal-player", targetPlayerId: P2, minMax: "max" },
      P1,
      NOW,
    );
    expect(maxReveal.players[1].hand.find((c) => c.isRevealed)?.number).toBe(9);
  });

  it("lets the current player reveal their own min and max", () => {
    const state = inGameState({
      hands: { [P1]: [card("k1", 12), card("k2", 1), card("k3", 7)] },
    });
    const minReveal = applyGameAction(
      state,
      { type: "reveal-player", targetPlayerId: P1, minMax: "min" },
      P1,
      NOW,
    );
    expect(minReveal.players[0].hand.find((c) => c.isRevealed)?.number).toBe(1);

    const fresh = inGameState({
      hands: { [P1]: [card("k1", 12), card("k2", 1), card("k3", 7)] },
    });
    const maxReveal = applyGameAction(
      fresh,
      { type: "reveal-player", targetPlayerId: P1, minMax: "max" },
      P1,
      NOW,
    );
    expect(maxReveal.players[0].hand.find((c) => c.isRevealed)?.number).toBe(12);
  });

  it("reveals only one copy among duplicate values", () => {
    const state = inGameState({
      hands: { [P2]: [card("d1", 2), card("d2", 2), card("d3", 8)] },
    });
    const next = applyGameAction(
      state,
      { type: "reveal-player", targetPlayerId: P2, minMax: "min" },
      P1,
      NOW,
    );
    const revealed = next.players[1].hand.filter((c) => c.isRevealed);
    expect(revealed).toHaveLength(1);
    expect(revealed[0].number).toBe(2);
  });

  it("enters settling on a mismatched second reveal", () => {
    const state = inGameState({
      hands: { [P1]: [card("h1", 5, true)] },
      publicCards: [card("p1", 4)],
    });
    const next = applyGameAction(state, { type: "reveal-public", cardId: "p1" }, P1, NOW + 7);
    expect(next.gameSubStage).toBe("sub:settling");
    expect(next.timestamp).toBe(NOW + 7);
  });

  it("enters settling after three matching reveals", () => {
    const state = inGameState({
      hands: { [P1]: [card("h1", 5, true)], [P2]: [card("h2", 5, true)] },
      publicCards: [card("p1", 5)],
    });
    const next = applyGameAction(state, { type: "reveal-public", cardId: "p1" }, P1, NOW + 7);
    expect(next.gameSubStage).toBe("sub:settling");
  });

  it("rejects an unknown public card without advancing the game", () => {
    const state = base();
    expectInputUnchanged(
      state,
      () => applyGameAction(state, { type: "reveal-public", cardId: "nope" }, P1, NOW),
      /Unknown card/,
    );
    expect(state.gameSubStage).toBe("sub:playing");
  });

  it("rejects revealing an already revealed public card", () => {
    const state = inGameState({
      hands: { [P1]: [card("h1", 5, true)] },
      publicCards: [card("p1", 4, true), card("p2", 6)],
    });
    expectInputUnchanged(
      state,
      () => applyGameAction(state, { type: "reveal-public", cardId: "p1" }, P1, NOW),
      ConflictError,
    );
  });

  it("rejects a reveal by a member who is not the current player", () => {
    const state = base();
    expectInputUnchanged(
      state,
      () => applyGameAction(state, { type: "reveal-public", cardId: "p1" }, P2, NOW),
      /Not your turn/,
    );
  });

  it("rejects reveals outside an active game", () => {
    const lobby = lobbyState([P1]);
    expect(() =>
      applyGameAction(lobby, { type: "reveal-public", cardId: "p1" }, P1, NOW),
    ).toThrow(ConflictError);
    expect(() =>
      applyGameAction(lobby, { type: "reveal-player", targetPlayerId: P1, minMax: "min" }, P1, NOW),
    ).toThrow(ConflictError);
  });

  it("rejects reveals during the settling window", () => {
    const state = inGameState({
      subStage: "sub:settling",
      hands: { [P1]: [card("h1", 5, true)] },
      publicCards: [card("p1", 4, true)],
    });
    expectInputUnchanged(
      state,
      () => applyGameAction(state, { type: "reveal-public", cardId: "p1" }, P1, NOW),
      ConflictError,
    );
  });

  it("rejects a player reveal with an unknown target player", () => {
    const state = inGameState({
      hands: { [P2]: [card("h1", 5)] },
    });
    expectInputUnchanged(
      state,
      () =>
        applyGameAction(
          state,
          { type: "reveal-player", targetPlayerId: STRANGER, minMax: "min" },
          P1,
          NOW,
        ),
      /Unknown target player/,
    );
  });

  it("rejects a player reveal when the target has no unrevealed cards", () => {
    const state = inGameState({
      hands: { [P2]: [card("h1", 5, true)] },
    });
    expectInputUnchanged(
      state,
      () =>
        applyGameAction(
          state,
          { type: "reveal-player", targetPlayerId: P2, minMax: "min" },
          P1,
          NOW,
        ),
      /No more cards/,
    );
  });

  it("rejects a player reveal when the target hand is empty", () => {
    const state = inGameState({
      hands: { [P2]: [] },
    });
    expectInputUnchanged(
      state,
      () =>
        applyGameAction(
          state,
          { type: "reveal-player", targetPlayerId: P2, minMax: "min" },
          P1,
          NOW,
        ),
      /No more cards/,
    );
  });

  it("does not mutate the input state", () => {
    const state = base();
    const before = snapshot(state);
    applyGameAction(state, { type: "reveal-public", cardId: "p1" }, P1, NOW);
    expect(snapshot(state)).toBe(before);
  });
});

describe("chat", () => {
  it("prepends a member message with the acting player's name and time", () => {
    const state = lobbyState([P1, P2]);
    const next = applyGameAction(state, { type: "chat", message: "hello" }, P2, NOW + 30);
    expect(next.messages).toEqual([
      { playerName: "Player 2", content: "hello", timestamp: NOW + 30 },
    ]);
  });

  it("rejects chat from a non-member", () => {
    const state = lobbyState([P1]);
    expect(() =>
      applyGameAction(state, { type: "chat", message: "hello" }, STRANGER, NOW),
    ).toThrow(/not in this game/);
  });
});

describe("settlement", () => {
  const settlingState = (options: InGameOptions = {}): ServerState =>
    inGameState({ ...options, subStage: "sub:settling", timestamp: NOW });

  const successState = () =>
    settlingState({
      hands: {
        [P1]: [card("h1", 5, true), card("h2", 6)],
        [P2]: [card("h3", 5, true)],
        [P3]: [card("h4", 8)],
      },
      publicCards: [card("p1", 5, true), card("p2", 9)],
    });

  it("collects matching cards, conceals the rest, and passes the turn after two seconds", () => {
    const next = settleIfOverdue(successState(), P3, NOW + SETTLE_DELAY_MS + 1);
    expect(next.gameSubStage).toBe("sub:playing");
    expect(next.timestamp).toBe(NOW + SETTLE_DELAY_MS + 1);

    // Collected the three matching fives.
    expect(next.players[0].collection.map((c) => c.number)).toEqual([5, 5, 5]);
    expect(next.players[0].collection.every((c) => c.isRevealed)).toBe(true);
    expect(next.players[0].hand.map((c) => c.number)).toEqual([6]);

    // Matching cards removed from hands and public slots; positions preserved.
    expect(next.players[1].hand).toEqual([]);
    expect(next.publicCards).toHaveLength(2);
    expect(next.publicCards![0].id).toBe("");
    expect(next.publicCards![1]).toMatchObject({ id: "p2", number: 9, isRevealed: false });

    // Everything concealed.
    for (const player of next.players) {
      for (const dealt of player.hand) expect(dealt.isRevealed).toBe(false);
    }

    // Turn passes to the next player.
    expect(next.players.map((p) => p.isPlaying)).toEqual([false, true, false]);
  });

  it("does not settle before the two-second delay elapses", () => {
    const state = successState();
    expectUnchanged(state, settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS - 1));
    expectUnchanged(state, settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS));
  });

  it("settles exactly once", () => {
    const first = settleIfOverdue(successState(), P2, NOW + SETTLE_DELAY_MS + 1);
    const second = settleIfOverdue(first, P2, NOW + SETTLE_DELAY_MS + 2);
    expectUnchanged(first, second);
    expect(second.players[0].collection).toHaveLength(3);
  });

  it("lets any authenticated member's poll trigger an overdue settlement", () => {
    // P3 is not the current player but can unstick the room.
    const next = settleIfOverdue(successState(), P3, NOW + SETTLE_DELAY_MS + 1);
    expect(next.players.map((p) => p.isPlaying)).toEqual([false, true, false]);
    expect(next.players[0].collection).toHaveLength(3);
  });

  it("rejects a settlement poll by a non-member", () => {
    const state = successState();
    expectInputUnchanged(
      state,
      () => settleIfOverdue(state, STRANGER, NOW + SETTLE_DELAY_MS + 1),
      /not in this game/,
    );
  });

  it("leaves a non-settling state untouched", () => {
    const state = inGameState();
    expectUnchanged(state, settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1));
  });

  it("wraps the turn around to the first seat after the last player", () => {
    // The current player sits in the last seat, so the next player is the
    // first one again.
    const state = settlingState({ current: P3 });
    expect(state.players.map((p) => p.isPlaying)).toEqual([false, false, true]);

    const next = settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expect(next.players.map((p) => p.isPlaying)).toEqual([true, false, false]);
    expect(next.players[0].id).toBe(P1);
    expect(next.gameSubStage).toBe("sub:playing");
    expect(next.gameStage).toBe("stage:in-game");
  });

  it("does not settle a game that is already over", () => {
    const state: ServerState = {
      ...inGameState(),
      gameStage: "stage:game-over",
      gameSubStage: null,
    };
    const next = settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expectUnchanged(state, next);
    expect(next.gameStage).toBe("stage:game-over");
    expect(next.gameSubStage).toBeNull();
    expect(next.players.map((p) => p.isWinner)).toEqual([false, false, false]);
  });

  it("does not collect cards on a failed challenge but still passes the turn", () => {
    const state = settlingState({
      hands: { [P1]: [card("h1", 5, true)], [P2]: [card("h3", 6, true)] },
      publicCards: [],
    });
    const next = settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expect(next.players[0].collection).toHaveLength(0);
    expect(next.players.map((p) => p.isPlaying)).toEqual([false, true, false]);
    expect(next.gameSubStage).toBe("sub:playing");
    expect(next.players[0].hand[0].isRevealed).toBe(false);
    expect(next.players[1].hand[0].isRevealed).toBe(false);
  });

  it("declares a winner after three collected sets (nine cards)", () => {
    const collections = [
      card("c1", 1), card("c2", 1), card("c3", 1),
      card("c4", 2), card("c5", 2), card("c6", 2),
    ];
    const state = settlingState({
      hands: {
        [P1]: [card("h1", 5, true), card("h2", 6)],
        [P2]: [card("h3", 5, true)],
      },
      publicCards: [card("p1", 5, true)],
      collections: { [P1]: collections },
    });
    const next = settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expect(next.gameStage).toBe("stage:game-over");
    expect(next.gameSubStage).toBeNull();
    expect(next.players.map((p) => p.isPlaying)).toEqual([false, false, false]);
    expect(next.players[0].isWinner).toBe(true);
    expect(next.players[0].collection).toHaveLength(9);
  });

  it("declares a winner with two set values summing to seven", () => {
    const collections = [
      card("c1", 1), card("c2", 1), card("c3", 1),
      card("c4", 6), card("c5", 6), card("c6", 6),
    ];
    const state = settlingState({
      hands: { [P1]: [card("h1", 5, true)], [P2]: [card("h3", 8, true)] },
      collections: { [P1]: collections },
    });
    const next = settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expect(next.gameStage).toBe("stage:game-over");
    expect(next.players[0].isWinner).toBe(true);
  });

  it("declares a winner with two set values differing by seven", () => {
    const collections = [
      card("c1", 4), card("c2", 4), card("c3", 4),
      card("c4", 11), card("c5", 11), card("c6", 11),
    ];
    const state = settlingState({
      hands: { [P1]: [card("h1", 5, true)], [P2]: [card("h3", 8, true)] },
      collections: { [P1]: collections },
    });
    const next = settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expect(next.gameStage).toBe("stage:game-over");
    expect(next.players[0].isWinner).toBe(true);
  });

  it("declares a winner with one set of sevens", () => {
    const collections = [card("c1", 7), card("c2", 7), card("c3", 7)];
    const state = settlingState({
      hands: { [P1]: [card("h1", 5, true)], [P2]: [card("h3", 8, true)] },
      collections: { [P1]: collections },
    });
    const next = settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expect(next.gameStage).toBe("stage:game-over");
    expect(next.players[0].isWinner).toBe(true);
  });

  it("keeps the game going when no victory condition is met", () => {
    const collections = [
      card("c1", 1), card("c2", 1), card("c3", 1),
      card("c4", 2), card("c5", 2), card("c6", 2),
    ];
    const state = settlingState({
      hands: { [P1]: [card("h1", 5, true)], [P2]: [card("h3", 8, true)] },
      collections: { [P1]: collections },
    });
    const next = settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expect(next.gameStage).toBe("stage:in-game");
    expect(next.players[0].isWinner).toBe(false);
    expect(next.players.map((p) => p.isPlaying)).toEqual([false, true, false]);
  });

  it("does not mutate the input state", () => {
    const state = successState();
    const before = snapshot(state);
    settleIfOverdue(state, P2, NOW + SETTLE_DELAY_MS + 1);
    expect(snapshot(state)).toBe(before);
  });
});

describe("default engine dependencies", () => {
  it("generates unique cryptographically random opaque card ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const id = defaultGameEngineDeps.generateCardId();
      expect(id).toMatch(/^[0-9a-f]+$/);
      // Never value-bearing like the legacy "7-a" ids.
      expect(id).not.toMatch(/^\d+-[abc]$/);
      ids.add(id);
    }
    expect(ids.size).toBe(64);
  });

  it("shuffles as a pure permutation", () => {
    const input = Array.from({ length: 36 }, (_, i) => i);
    const output = defaultGameEngineDeps.shuffle(input);
    expect(output).toHaveLength(input.length);
    expect([...output].sort((a, b) => a - b)).toEqual(input);
    expect(input).toEqual(Array.from({ length: 36 }, (_, i) => i));
  });
});
