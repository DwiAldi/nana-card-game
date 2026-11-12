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
const cardNumber = (c: PublicCard): number => (c.isRevealed ? c.number : Number.NaN);

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

const HIDDEN_VALUES = [2, 5, 7, 11, 12];

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
  it("exposes hidden hand cards as { id, isRevealed: false } with no number", () => {
    const publicState = toPublicState(fixtureState(), P1);
    const me = publicState.players.find((p) => p.id === P1);
    expect(me).toBeDefined();
    const hiddenCards = me!.hand.filter((c) => !c.isRevealed);
    expect(hiddenCards.map((c) => c.id).sort()).toEqual(["7-a", "opaque-h1"].sort());
    for (const hiddenCard of hiddenCards) {
      expect(hiddenCard).not.toHaveProperty("number");
      expect(Object.keys(hiddenCard).sort()).toEqual(["id", "isRevealed"]);
    }
    const revealedCard = me!.hand.find((c) => c.isRevealed)!;
    expect(revealedCard).toEqual({ id: "opaque-r1", isRevealed: true, number: 9 });
    expect(Object.keys(revealedCard).sort()).toEqual(["id", "isRevealed", "number"]);
  });

  it("never serializes a known hidden number anywhere in the payload", () => {
    expectNoHiddenValueLeak(toPublicState(fixtureState(), P1));
    expectNoHiddenValueLeak(toPublicState(fixtureState(), P2));
    expectNoHiddenValueLeak(toPublicState(fixtureState(), P3));
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
    const publicState = toPublicState(concealed, P1);
    const me = publicState.players.find((p) => p.id === P1)!;
    expect(me.collection).toEqual([
      { id: "3-a", isRevealed: true, number: 3 },
      { id: "3-b", isRevealed: true, number: 3 },
      { id: "3-c", isRevealed: true, number: 3 },
    ]);
    // Concealed cards in all hands remain hidden after the conceal pass.
    for (const player of publicState.players) {
      for (const handCard of player.hand) {
        expect(handCard.isRevealed).toBe(false);
        expect(handCard).not.toHaveProperty("number");
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
    expectNoHiddenValueLeak(publicState);
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
    expectNoHiddenValueLeak(publicState, [...HIDDEN_VALUES, 9, 8]);
    expectNoSessionMaterial(publicState);
    for (const player of publicState.players) {
      for (const handCard of player.hand) {
        expect(handCard).not.toHaveProperty("number");
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
    expectNoHiddenValueLeak(publicState, [5, 7, 11, 12]);
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
          expect(handCard).not.toHaveProperty("number");
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
});
