import { describe, expect, it } from "vitest";
import type { Card, PublicCard, ServerState } from "@/types";
import { concealAllCards } from "@/lib/game-helper";
import {
  applyGameAction,
  createGameState,
  settleIfOverdue,
} from "../game-engine";
import { toPublicState } from "../public-state";

const NOW = 1_700_000_000_000;

/** 32-hex-char player ids, as minted by the session layer. */
const P1 = "a1".repeat(16);
const P2 = "b2".repeat(16);
const P3 = "c3".repeat(16);

const card = (id: string, number: number, isRevealed = false): Card => ({
  id,
  number,
  isRevealed,
});

/** Collection cards always serialize as visible; unwraps the union safely. */
const cardNumber = (c: PublicCard): number => c.number ?? Number.NaN;

/**
 * A mid-game fixture with known hidden values. The hidden numbers 2, 5, 7,
 * 11 and 12 appear nowhere in a revealed position, so any leak of them is
 * detectable by exact substring assertions.
 */
const fixtureState = (): ServerState => ({
  gameId: "roomabc123",
  gameStage: "stage:in-game",
  gameSubStage: "sub:settling", // mismatched reveals 9 and 8 below
  timestamp: NOW,
  players: [
    {
      id: P1,
      name: "Player 1",
      seat: 1,
      isHost: true,
      isPlaying: true,
      isWinner: false,
      hand: [
        card("opaque-h1", 5), // hidden
        card("7-a", 7), // hidden, legacy value-bearing id
        card("opaque-r1", 9, true), // revealed
      ],
      collection: [
        card("3-a", 3, true),
        card("3-b", 3, true),
        card("3-c", 3, true),
      ],
    },
    {
      id: P2,
      name: "Player 2",
      seat: 2,
      isHost: false,
      isPlaying: false,
      isWinner: false,
      hand: [
        card("12-c", 12), // hidden, legacy value-bearing id
        card("2-b", 2), // hidden
      ],
      collection: [],
    },
    {
      id: P3,
      name: "Player 3",
      seat: 3,
      isHost: false,
      isPlaying: false,
      isWinner: false,
      hand: [],
      collection: [],
    },
  ],
  cardDeck: [
    card("deck-1", 4),
    card("deck-2", 10),
  ],
  publicCards: [
    card("11-a", 11), // hidden, legacy value-bearing id
    card("", 2, false), // stable empty slot for a removed card
    card("8-b", 8, true), // revealed
  ],
  messages: [{ playerName: "Player 2", content: "hi", timestamp: NOW }],
});

/** Every hidden number in the fixture, including the hidden public slot. */
const HIDDEN_VALUES = [2, 5, 7, 11, 12];

/** The hidden numbers each player holds in the fixture. */
const HIDDEN_VALUES_BY_PLAYER: Record<string, number[]> = {
  [P1]: [5, 7],
  [P2]: [12, 2],
  [P3]: [],
};

/**
 * Hidden numbers that must not appear in `viewerId`'s view: every hidden
 * value except the ones the viewer legitimately owns and may see.
 */
const foreignHiddenValues = (viewerId: string): number[] => {
  const own = HIDDEN_VALUES_BY_PLAYER[viewerId] ?? [];
  return HIDDEN_VALUES.filter((value) => !own.includes(value));
};

const expectNoHiddenValueLeak = (publicState: unknown, hiddenValues: number[] = HIDDEN_VALUES): void => {
  const serialized = JSON.stringify(publicState);
  for (const value of hiddenValues) {
    expect(serialized).not.toContain(`"number":${value}`);
  }
};

/** No session, token or digest field anywhere in the serialized tree. */
const expectNoSessionMaterial = (publicState: unknown): void => {
  const serialized = JSON.stringify(publicState);
  expect(serialized).not.toMatch(/"(session|sessions|token|digest|sessionDigest)"/);
  const queue: unknown[] = [publicState];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      expect(key.toLowerCase()).not.toMatch(/session|token|digest/);
      queue.push(value);
    }
  }
};

describe("toPublicState", () => {
  it("shows the viewer's own hidden hand cards with their numbers", () => {
    const publicState = toPublicState(fixtureState(), P1);
    const me = publicState.players.find((p) => p.id === P1)!;
    expect(me.hand).toEqual([
      { id: "opaque-h1", isRevealed: false, number: 5 },
      { id: "7-a", isRevealed: false, number: 7 },
      { id: "opaque-r1", isRevealed: true, number: 9 },
    ]);
  });

  it("gives every viewer their own hand numbers and nobody else's", () => {
    const expectedOwnNumbers: Record<string, number[]> = {
      [P1]: [5, 7, 9],
      [P2]: [12, 2],
      [P3]: [],
    };
    for (const [viewerId, expected] of Object.entries(expectedOwnNumbers)) {
      const publicState = toPublicState(fixtureState(), viewerId);
      const me = publicState.players.find((p) => p.id === viewerId)!;
      expect(me.hand.map(cardNumber).sort((a, b) => a - b)).toEqual(
        [...expected].sort((a, b) => a - b),
      );
    }
  });

  it("conceals other players' hidden hand cards as { id, isRevealed: false } with no number", () => {
    const publicState = toPublicState(fixtureState(), P3);
    const player1 = publicState.players.find((p) => p.id === P1)!;
    const hiddenCards = player1.hand.filter((c) => !c.isRevealed);
    expect(hiddenCards.map((c) => c.id).sort()).toEqual(["7-a", "opaque-h1"].sort());
    for (const hiddenCard of hiddenCards) {
      expect(hiddenCard).not.toHaveProperty("number");
      expect(Object.keys(hiddenCard).sort()).toEqual(["id", "isRevealed"]);
    }
    const revealedCard = player1.hand.find((c) => c.isRevealed)!;
    expect(revealedCard).toEqual({ id: "opaque-r1", isRevealed: true, number: 9 });
    expect(Object.keys(revealedCard).sort()).toEqual(["id", "isRevealed", "number"]);
  });

  it("never serializes another player's known hidden number anywhere in the payload", () => {
    expectNoHiddenValueLeak(toPublicState(fixtureState(), P1), foreignHiddenValues(P1));
    expectNoHiddenValueLeak(toPublicState(fixtureState(), P2), foreignHiddenValues(P2));
    expectNoHiddenValueLeak(toPublicState(fixtureState(), P3), foreignHiddenValues(P3));
  });

  it("keeps one player's hidden numbers out of the other player's view", () => {
    const asP1 = JSON.stringify(toPublicState(fixtureState(), P1));
    const asP2 = JSON.stringify(toPublicState(fixtureState(), P2));
    const asP3 = JSON.stringify(toPublicState(fixtureState(), P3));

    // Player 2 sees neither Player 1's nor Player 3's hidden numbers.
    for (const value of HIDDEN_VALUES_BY_PLAYER[P1]) {
      expect(asP2).not.toContain(`"number":${value}`);
      expect(asP3).not.toContain(`"number":${value}`);
    }
    // Player 1 sees neither Player 2's nor Player 3's hidden numbers.
    for (const value of HIDDEN_VALUES_BY_PLAYER[P2]) {
      expect(asP1).not.toContain(`"number":${value}`);
      expect(asP3).not.toContain(`"number":${value}`);
    }
    // The hidden public card stays hidden for everybody.
    for (const view of [asP1, asP2, asP3]) {
      expect(view).not.toContain(`"number":11`);
    }
  });

  it("hides empty public slots without leaking the removed value and keeps positions", () => {
    const publicState = toPublicState(fixtureState(), P1);
    expect(publicState.publicCards.map((c) => c.id)).toEqual(["11-a", "", "8-b"]);
    const emptySlot = publicState.publicCards[1];
    expect(emptySlot).toEqual({ id: "", isRevealed: false });
    expect(emptySlot).not.toHaveProperty("number");
    expect(publicState.publicCards[0]).toEqual({ id: "11-a", isRevealed: false });
    expect(publicState.publicCards[2]).toEqual({ id: "8-b", isRevealed: true, number: 8 });
  });

  it("serializes collected cards as visible even after a conceal pass", () => {
    const concealed = structuredClone(fixtureState());
    concealAllCards(concealed);
    const publicState = toPublicState(concealed, P3);
    const player1 = publicState.players.find((p) => p.id === P1)!;
    expect(player1.collection).toEqual([
      { id: "3-a", isRevealed: true, number: 3 },
      { id: "3-b", isRevealed: true, number: 3 },
      { id: "3-c", isRevealed: true, number: 3 },
    ]);
    // Concealed cards in every hand remain hidden for a third-party viewer.
    for (const player of publicState.players) {
      for (const handCard of player.hand) {
        expect(handCard.isRevealed).toBe(false);
        if (player.id === P3) expect(typeof handCard.number).toBe("number");
        else expect(handCard).not.toHaveProperty("number");
      }
    }
    expectNoHiddenValueLeak(publicState, [...HIDDEN_VALUES, 9, 8]);
  });

  it("carries viewerId and omits the deck, sessions and any session material", () => {
    const state = fixtureState();
    // Even if privileged fields somehow end up on the server state, the
    // serializer whitelists and must drop them.
    const withSecrets = {
      ...state,
      cardDeck: state.cardDeck,
      sessions: [{ digest: "deadbeef", playerId: P1 }],
      token: "super-secret-token",
      sessionDigest: "cafebabe",
    } as unknown as ServerState;
    const publicState = toPublicState(withSecrets, P2);
    expect(publicState.viewerId).toBe(P2);
    expect(publicState).not.toHaveProperty("cardDeck");
    expect(publicState).not.toHaveProperty("sessions");
    expect(publicState).not.toHaveProperty("token");
    expect(publicState).not.toHaveProperty("sessionDigest");
    expectNoSessionMaterial(publicState);
    expectNoHiddenValueLeak(publicState, foreignHiddenValues(P2));
  });

  it("passes through stage, substage, timestamp, players and messages", () => {
    const publicState = toPublicState(fixtureState(), P3);
    expect(publicState.gameId).toBe("roomabc123");
    expect(publicState.gameStage).toBe("stage:in-game");
    expect(publicState.gameSubStage).toBe("sub:settling");
    expect(publicState.timestamp).toBe(NOW);
    expect(publicState.players.map((p) => p.id)).toEqual([P1, P2, P3]);
    expect(publicState.players.map((p) => p.name)).toEqual(["Player 1", "Player 2", "Player 3"]);
    expect(publicState.players.map((p) => p.seat)).toEqual([1, 2, 3]);
    expect(publicState.players.map((p) => p.isHost)).toEqual([true, false, false]);
    expect(publicState.players.map((p) => p.isPlaying)).toEqual([true, false, false]);
    expect(publicState.messages).toEqual([
      { playerName: "Player 2", content: "hi", timestamp: NOW },
    ]);
  });

  it("serializes the GET poll path (overdue settlement by any member) without leaks", () => {
    const settled = settleIfOverdue(fixtureState(), P3, NOW + 2501);
    const publicState = toPublicState(settled, P2);
    expect(publicState.gameSubStage).toBe("sub:playing");
    // After settlement everything was concealed, including the 9 and 8.
    expectNoHiddenValueLeak(publicState, [...foreignHiddenValues(P2), 9, 8]);
    expectNoSessionMaterial(publicState);
    // Only the viewer's own hand keeps its numbers.
    for (const player of publicState.players) {
      const isViewer = player.id === P2;
      for (const handCard of player.hand) {
        if (isViewer) {
          expect(Number.isFinite(cardNumber(handCard))).toBe(true);
        } else {
          expect(handCard).not.toHaveProperty("number");
        }
      }
    }
    // Collections stay visible through the conceal pass.
    expect(publicState.players[0].collection.map(cardNumber)).toEqual([3, 3, 3]);
  });

  it("serializes the POST action path without leaks beyond the intentional reveal", () => {
    const state = {
      ...fixtureState(),
      gameSubStage: "sub:playing" as const,
    };
    // Current player reveals Player 2's minimum card (value 2).
    const acted = applyGameAction(
      state,
      { type: "reveal-player", targetPlayerId: P2, minMax: "min" },
      P1,
      NOW,
    );
    const publicState = toPublicState(acted, P3);
    // The revealed 2 is now public knowledge for every viewer.
    const player2 = publicState.players.find((p) => p.id === P2)!;
    expect(player2.hand).toContainEqual({ id: "2-b", isRevealed: true, number: 2 });
    expect(player2.hand.find((c) => c.id === "12-c")).toEqual({ id: "12-c", isRevealed: false });
    // Every other hidden number stays hidden.
    expectNoHiddenValueLeak(publicState, foreignHiddenValues(P3).filter((v) => v !== 2));
    expectNoSessionMaterial(publicState);
  });

  it("never exposes value-bearing ids for engine-dealt hidden cards", () => {
    let state = createGameState("roomabc123", P1, "Host", NOW);
    state = applyGameAction(state, { type: "join", name: "Two" }, P2, NOW);
    state = applyGameAction(state, { type: "join", name: "Three" }, P3, NOW);
    state = applyGameAction(state, { type: "start" }, P1, NOW);
    const publicState = toPublicState(state, P2);
    for (const player of publicState.players) {
      for (const handCard of player.hand) {
        if (!handCard.isRevealed) {
          expect(handCard.id).not.toMatch(/^\d+-[abc]$/);
          if (player.id === P2) expect(typeof handCard.number).toBe("number");
          else expect(handCard).not.toHaveProperty("number");
        } else {
          expect(typeof handCard.number).toBe("number");
        }
      }
    }
    for (const tableCard of publicState.publicCards) {
      if (!tableCard.isRevealed) {
        expect(tableCard.id).not.toMatch(/^\d+-[abc]$/);
        expect(tableCard).not.toHaveProperty("number");
      }
    }
    expectNoSessionMaterial(publicState);
  });

  it("shows engine-dealt cards to their owner only", () => {
    let state = createGameState("roomabc123", P1, "Host", NOW);
    state = applyGameAction(state, { type: "join", name: "Two" }, P2, NOW);
    state = applyGameAction(state, { type: "join", name: "Three" }, P3, NOW);
    state = applyGameAction(state, { type: "start" }, P1, NOW);

    const asOwner = toPublicState(state, P2);
    const owner = asOwner.players.find((p) => p.id === P2)!;
    expect(owner.hand).toHaveLength(8);
    for (const handCard of owner.hand) {
      expect(handCard.isRevealed).toBe(false);
      expect(Number.isFinite(cardNumber(handCard))).toBe(true);
    }

    // A third-party viewer sees the very same cards concealed.
    const asSpectator = toPublicState(state, P3);
    const sameHand = asSpectator.players.find((p) => p.id === P2)!;
    expect(sameHand.hand.map((c) => c.id)).toEqual(owner.hand.map((c) => c.id));
    for (const handCard of sameHand.hand) {
      expect(handCard.isRevealed).toBe(false);
      expect(handCard).not.toHaveProperty("number");
    }
  });
});
