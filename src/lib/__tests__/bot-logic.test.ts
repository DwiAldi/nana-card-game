import { describe, test, expect } from "vitest";
import { Card, Player } from "@/types";
import {
  initBotMemory,
  updateMemoryOnReveal,
  updateMemoryOnCollect,
  getKnownHeadValue,
  getKnownTailValue,
  getHandSize,
  getGlobalRemainingCount,
  getExcludedNumbers,
  getUnknownPublicCount,
  getKnownPublicCountForNumber,
  calculateProbability,
  makeBotDecision,
  getNumberRangeForPlayerCount,
  getAllPossibleActions,
  evaluateAllActions,
} from "../bot-logic";

// Helper functions to create test data
function createCard(id: string, number: number, isRevealed = false): Card {
  return { id, number, isRevealed };
}

function createPlayer(
  id: string,
  hand: Card[],
  options: Partial<Player> = {}
): Player {
  return {
    id,
    name: id,
    seat: 1,
    isHost: false,
    isPlaying: false,
    hand,
    collection: [],
    ...options,
  };
}

function createTestPlayers(): Player[] {
  return [
    createPlayer("me", [
      createCard("2-a", 2),
      createCard("5-b", 5),
      createCard("8-c", 8),
    ]),
    createPlayer("bot-1", [
      createCard("3-a", 3),
      createCard("6-b", 6),
      createCard("9-c", 9),
    ]),
    createPlayer("bot-2", [
      createCard("4-a", 4),
      createCard("7-b", 7),
      createCard("10-c", 10),
    ]),
  ];
}

function createTestPublicCards(): Card[] {
  return [
    createCard("1-a", 1),
    createCard("1-b", 1),
    createCard("11-a", 11),
    createCard("12-a", 12),
  ];
}

// ==================== Memory Initialization Tests ====================

describe("BotMemory Initialization", () => {
  const players = createTestPlayers();
  const publicCards = createTestPublicCards();
  const botHand = players[1].hand; // bot-1's hand

  test("initializes the bot's own hand with fully known values", () => {
    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    expect(memory.myHand).toHaveLength(3);
    expect(memory.myHand[0]).toEqual({ cardId: "3-a", number: 3 });
    expect(memory.myHand[1]).toEqual({ cardId: "6-b", number: 6 });
    expect(memory.myHand[2]).toEqual({ cardId: "9-c", number: 9 });
  });

  test("initializes other players' hands with unknown values", () => {
    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    const meHand = memory.otherPlayersHands.get("me");
    expect(meHand?.cards).toHaveLength(3);
    expect(meHand?.cards.every((slot) => slot.number === null)).toBe(true);

    const bot2Hand = memory.otherPlayersHands.get("bot-2");
    expect(bot2Hand?.cards).toHaveLength(3);
    expect(bot2Hand?.cards.every((slot) => slot.number === null)).toBe(true);
  });

  test("initializes public cards with unknown values", () => {
    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    expect(memory.publicCards).toHaveLength(4);
    expect(memory.publicCards.every((slot) => slot.number === null)).toBe(true);
  });

  test("sets the number range correctly", () => {
    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 10 }
    );

    expect(memory.numberRange).toEqual({ min: 1, max: 10 });
  });

  test("initializes an empty collection record", () => {
    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    expect(memory.collectedSets.size).toBe(0);
  });
});

// ==================== Memory Update Tests ====================

describe("Memory Update on Reveal", () => {
  const players = createTestPlayers();
  const publicCards = createTestPublicCards();
  const botHand = players[1].hand;

  test("updates the matching slot when another player's card is revealed", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    const cardId = memory.otherPlayersHands.get("me")!.cards[0].cardId;

    memory = updateMemoryOnReveal(memory, cardId, 2, {
      type: "player",
      playerId: "me",
    });

    expect(memory.otherPlayersHands.get("me")?.cards[0].number).toBe(2);
  });

  test("updates the matching slot when a public card is revealed", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    const cardId = memory.publicCards[0].cardId;

    memory = updateMemoryOnReveal(memory, cardId, 1, { type: "public" });

    expect(memory.publicCards[0].number).toBe(1);
  });

  test("updates immutably by returning a new object", () => {
    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    const cardId = memory.publicCards[0].cardId;
    const newMemory = updateMemoryOnReveal(memory, cardId, 1, { type: "public" });

    expect(newMemory).not.toBe(memory);
    expect(newMemory.publicCards).not.toBe(memory.publicCards);
    expect(memory.publicCards[0].number).toBeNull(); // Original object is unchanged.
    expect(newMemory.publicCards[0].number).toBe(1); // New object contains the update.
  });

  test("updates correctly when revealing an already known card from its own hand", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    memory = updateMemoryOnReveal(memory, "3-a", 3, {
      type: "player",
      playerId: "bot-1",
    });

    expect(memory.myHand[0].number).toBe(3);
  });
});

describe("Memory Update on Collect", () => {
  const players = createTestPlayers();
  const publicCards = createTestPublicCards();
  const botHand = players[1].hand;

  test("records a collected set of three", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    memory = updateMemoryOnCollect(memory, "me", 5);

    expect(memory.collectedSets.get("me")).toContain(5);
  });

  test("removes the collected number from its own hand", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    const initialLength = memory.myHand.length;

    // bot-1 has no 5, so its hand is unchanged.
    memory = updateMemoryOnCollect(memory, "me", 5);
    expect(memory.myHand.length).toBe(initialLength);

    // bot-1 has a 3.
    memory = updateMemoryOnCollect(memory, "me", 3);
    expect(memory.myHand.length).toBe(initialLength - 1);
    expect(memory.myHand.find((s) => s.number === 3)).toBeUndefined();
  });

  test("removes known copies of a collected number from other players' hands", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    // Reveal a card first so its value is known.
    const cardId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
    memory = updateMemoryOnReveal(memory, cardId, 2, {
      type: "player",
      playerId: "me",
    });

    // Collect the 2s.
    memory = updateMemoryOnCollect(memory, "someone", 2);

    // The known 2 is removed from me's hand.
    const meCards = memory.otherPlayersHands.get("me")?.cards;
    expect(meCards?.find((s) => s.number === 2)).toBeUndefined();
  });

  test("removes known public copies of a collected number", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    // Reveal a public card first so its value is known.
    memory = updateMemoryOnReveal(memory, memory.publicCards[0].cardId, 1, {
      type: "public",
    });

    // Collect the 1s.
    memory = updateMemoryOnCollect(memory, "someone", 1);

    // The known public 1 is removed.
    expect(memory.publicCards.find((s) => s.number === 1)).toBeUndefined();
  });

  test("collecting a set is immutable", () => {
    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    const newMemory = updateMemoryOnCollect(memory, "me", 3);

    expect(newMemory).not.toBe(memory);
    expect(newMemory.collectedSets).not.toBe(memory.collectedSets);
    expect(memory.collectedSets.size).toBe(0);
    expect(newMemory.collectedSets.size).toBe(1);
  });
});

// ==================== Derived Calculations Tests ====================

describe("Derived Calculations", () => {
  describe("getKnownHeadValue / getKnownTailValue", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    test("always knows its own head and tail values", () => {
      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      expect(getKnownHeadValue(memory, "bot-1")).toBe(3);
      expect(getKnownTailValue(memory, "bot-1")).toBe(9);
    });

    test("returns null for other players' unrevealed head and tail values", () => {
      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      expect(getKnownHeadValue(memory, "me")).toBeNull();
      expect(getKnownTailValue(memory, "me")).toBeNull();
    });

    test("returns the head value after it is revealed", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );
      const headCardId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
      memory = updateMemoryOnReveal(memory, headCardId, 2, {
        type: "player",
        playerId: "me",
      });

      expect(getKnownHeadValue(memory, "me")).toBe(2);
    });

    test("returns the tail value after it is revealed", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );
      const meCards = memory.otherPlayersHands.get("me")!.cards;
      const tailCardId = meCards[meCards.length - 1].cardId;
      memory = updateMemoryOnReveal(memory, tailCardId, 8, {
        type: "player",
        playerId: "me",
      });

      expect(getKnownTailValue(memory, "me")).toBe(8);
    });

    test("returns null for an empty hand", () => {
      const emptyPlayers = [
        createPlayer("me", []),
        createPlayer("bot-1", [createCard("3-a", 3)]),
      ];
      const memory = initBotMemory(
        "bot-1",
        [createCard("3-a", 3)],
        emptyPlayers,
        publicCards,
        { min: 1, max: 12 }
      );

      expect(getKnownHeadValue(memory, "me")).toBeNull();
      expect(getKnownTailValue(memory, "me")).toBeNull();
    });
  });

  describe("getHandSize", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    test("returns the correct hand size", () => {
      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      expect(getHandSize(memory, "bot-1")).toBe(3);
      expect(getHandSize(memory, "me")).toBe(3);
    });

    test("reduces the hand size after collection", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );
      const before = getHandSize(memory, "bot-1");

      memory = updateMemoryOnCollect(memory, "me", 3); // bot-1 has one 3.

      expect(getHandSize(memory, "bot-1")).toBe(before - 1);
    });

    test("returns 0 for a nonexistent player", () => {
      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      expect(getHandSize(memory, "non-existent")).toBe(0);
    });
  });

  describe("getGlobalRemainingCount", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    test("initially counts three copies minus those in its own hand", () => {
      // bot-1's hand: [3, 6, 9].
      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      expect(getGlobalRemainingCount(memory, 3)).toBe(2); // 3-1=2
      expect(getGlobalRemainingCount(memory, 6)).toBe(2); // 3-1=2
      expect(getGlobalRemainingCount(memory, 1)).toBe(3); // Unknown locations.
    });

    test("returns 0 remaining copies after a number is collected", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );
      memory = updateMemoryOnCollect(memory, "me", 5);

      expect(getGlobalRemainingCount(memory, 5)).toBe(0);
    });

    test("updates the remaining count correctly after a reveal", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      // Reveal a public 1.
      memory = updateMemoryOnReveal(memory, memory.publicCards[0].cardId, 1, {
        type: "public",
      });

      // Two 1s now remain unaccounted for.
      expect(getGlobalRemainingCount(memory, 1)).toBe(2);
    });
  });

  describe("getExcludedNumbers", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    test("excludes numbers below the known head value", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );
      const headCardId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
      memory = updateMemoryOnReveal(memory, headCardId, 5, {
        type: "player",
        playerId: "me",
      });

      const excluded = getExcludedNumbers(memory, "me");
      expect(excluded.has(1)).toBe(true);
      expect(excluded.has(4)).toBe(true);
      expect(excluded.has(5)).toBe(false); // Do not exclude 5 itself.
      expect(excluded.has(6)).toBe(false);
    });

    test("excludes numbers above the known tail value", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );
      const meCards = memory.otherPlayersHands.get("me")!.cards;
      const tailCardId = meCards[meCards.length - 1].cardId;
      memory = updateMemoryOnReveal(memory, tailCardId, 9, {
        type: "player",
        playerId: "me",
      });

      const excluded = getExcludedNumbers(memory, "me");
      expect(excluded.has(10)).toBe(true);
      expect(excluded.has(12)).toBe(true);
      expect(excluded.has(9)).toBe(false);
      expect(excluded.has(8)).toBe(false);
    });

    test("excludes numbers based on its own actual hand range", () => {
      // bot-1's hand: [3, 6, 9].
      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      const excluded = getExcludedNumbers(memory, "bot-1");
      expect(excluded.has(1)).toBe(true); // < 3
      expect(excluded.has(2)).toBe(true); // < 3
      expect(excluded.has(3)).toBe(false); // Equals the head.
      expect(excluded.has(10)).toBe(true); // > 9
      expect(excluded.has(9)).toBe(false); // Equals the tail.
    });
  });

  describe("getUnknownPublicCount", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    test("all public cards are initially unknown", () => {
      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      expect(getUnknownPublicCount(memory)).toBe(4);
    });

    test("reduces the unknown count after revealing a public card", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      memory = updateMemoryOnReveal(memory, memory.publicCards[0].cardId, 1, {
        type: "public",
      });

      expect(getUnknownPublicCount(memory)).toBe(3);
    });
  });

  describe("getKnownPublicCountForNumber", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    test("initially has zero known public copies of every number", () => {
      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      expect(getKnownPublicCountForNumber(memory, 1)).toBe(0);
      expect(getKnownPublicCountForNumber(memory, 5)).toBe(0);
    });

    test("counts correctly after revealing public cards", () => {
      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      // Reveal two 1s.
      memory = updateMemoryOnReveal(memory, memory.publicCards[0].cardId, 1, {
        type: "public",
      });
      memory = updateMemoryOnReveal(memory, memory.publicCards[1].cardId, 1, {
        type: "public",
      });

      expect(getKnownPublicCountForNumber(memory, 1)).toBe(2);
    });
  });
});

// ==================== Probability Calculation Tests ====================

describe("Probability Calculation", () => {
  const players = createTestPlayers();
  const publicCards = createTestPublicCards();
  const botHand = players[1].hand;

  test("returns probability 1.0 when the known head matches the target", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    const headCardId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
    memory = updateMemoryOnReveal(memory, headCardId, 2, {
      type: "player",
      playerId: "me",
    });

    const prob = calculateProbability(memory, 2, {
      type: "player",
      playerId: "me",
      position: "head",
    });
    expect(prob).toBe(1.0);
  });

  test("returns probability 0.0 when the known head differs from the target", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    const headCardId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
    memory = updateMemoryOnReveal(memory, headCardId, 2, {
      type: "player",
      playerId: "me",
    });

    const prob = calculateProbability(memory, 5, {
      type: "player",
      playerId: "me",
      position: "head",
    });
    expect(prob).toBe(0.0);
  });

  test("returns probability 0 when the target number has been collected", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    memory = updateMemoryOnCollect(memory, "me", 5);

    const prob = calculateProbability(memory, 5, {
      type: "player",
      playerId: "me",
      position: "head",
    });
    expect(prob).toBe(0);
  });

  test("returns probability 0 when the head constraint excludes the target", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );
    // me's head is 5, so its hand cannot contain 1 through 4.
    const headCardId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
    memory = updateMemoryOnReveal(memory, headCardId, 5, {
      type: "player",
      playerId: "me",
    });

    const prob = calculateProbability(memory, 3, {
      type: "player",
      playerId: "me",
      position: "tail",
    });
    expect(prob).toBe(0);
  });

  test("calculates its own head and tail probabilities correctly", () => {
    // bot-1's hand: [3, 6, 9].
    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    // Its own head is 3.
    expect(
      calculateProbability(memory, 3, {
        type: "player",
        playerId: "bot-1",
        position: "head",
      })
    ).toBe(1.0);

    expect(
      calculateProbability(memory, 5, {
        type: "player",
        playerId: "bot-1",
        position: "head",
      })
    ).toBe(0.0);

    // Its own tail is 9.
    expect(
      calculateProbability(memory, 9, {
        type: "player",
        playerId: "bot-1",
        position: "tail",
      })
    ).toBe(1.0);
  });

  test("calculates public-area probability correctly", () => {
    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    // Of four public cards, reveal one 1.
    memory = updateMemoryOnReveal(memory, memory.publicCards[0].cardId, 1, {
      type: "public",
    });

    // Two 1s remain (one is known in public); estimate the probability among three unknown public cards.
    const prob = calculateProbability(memory, 1, { type: "public" });
    expect(prob).toBeGreaterThan(0);
    expect(prob).toBeLessThanOrEqual(1);
  });
});

// ==================== Decision Making Tests ====================

describe("Bot Decision Making", () => {
  describe("Empty chain (flip-1)", () => {
    test("prefers its own head card as a starting point", () => {
      const players = createTestPlayers();
      const publicCards = createTestPublicCards();
      const botHand = players[1].hand;

      const memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );
      const decision = makeBotDecision(memory, [], players, publicCards);

      expect(decision.action).toBe("reveal-player-card");
      expect(decision.playerId).toBe("bot-1"); // Itself.
      expect(decision.minMax).toBe("min"); // Head card.
    });

    test("uses knowledge of two locations with the same number", () => {
      const players = createTestPlayers();
      const publicCards = createTestPublicCards();
      const botHand = players[1].hand;

      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      // Set me's head to 4 and bot-2's head to 4.
      const meHeadId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
      const bot2HeadId = memory.otherPlayersHands.get("bot-2")!.cards[0].cardId;
      memory = updateMemoryOnReveal(memory, meHeadId, 4, {
        type: "player",
        playerId: "me",
      });
      memory = updateMemoryOnReveal(memory, bot2HeadId, 4, {
        type: "player",
        playerId: "bot-2",
      });

      const decision = makeBotDecision(memory, [], players, publicCards);

      // Reveal one of the heads known to be 4.
      expect(decision.action).toBe("reveal-player-card");
      expect(["me", "bot-2"]).toContain(decision.playerId);
      expect(decision.confidence).toBe(1.0);
    });
  });

  describe("One card revealed (flip-2)", () => {
    test("prefers a certain source", () => {
      const players = createTestPlayers();
      const publicCards = createTestPublicCards();
      const botHand = players[1].hand;

      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      // me's head is known to be 6.
      const meHeadId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
      memory = updateMemoryOnReveal(memory, meHeadId, 6, {
        type: "player",
        playerId: "me",
      });

      // The current chain contains one 6.
      const currentChain = [createCard("6-x", 6, true)];
      const decision = makeBotDecision(memory, currentChain, players, publicCards);

      expect(decision.action).toBe("reveal-player-card");
      expect(decision.playerId).toBe("me");
      expect(decision.minMax).toBe("min");
      expect(decision.confidence).toBe(1.0);
    });
  });

  describe("Two cards revealed (flip-3)", () => {
    test("immediately selects a certain third card at the head or tail", () => {
      // The bot's head card is 5.
      const customBotHand = [
        createCard("5-a", 5),
        createCard("7-c", 7),
        createCard("9-a", 9),
      ];
      const players = [
        createPlayer("me", [
          createCard("2-a", 2),
          createCard("6-b", 6),
          createCard("8-c", 8),
        ]),
        createPlayer("bot-1", customBotHand),
      ];
      const publicCards = createTestPublicCards();

      const memory = initBotMemory(
        "bot-1",
        customBotHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      const currentChain = [
        createCard("5-x", 5, true),
        createCard("5-y", 5, true),
      ];
      const decision = makeBotDecision(memory, currentChain, players, publicCards);

      // The bot knows its head is 5 and should reveal it.
      expect(decision.action).toBe("reveal-player-card");
      expect(decision.playerId).toBe("bot-1");
      expect(decision.minMax).toBe("min");
      expect(decision.confidence).toBe(1.0);
    });

    test("reveals its tail when it contains the target", () => {
      // The bot's tail card is 5.
      const customBotHand = [
        createCard("3-a", 3),
        createCard("4-c", 4),
        createCard("5-a", 5),
      ];
      const players = [
        createPlayer("me", [
          createCard("2-a", 2),
          createCard("6-b", 6),
          createCard("8-c", 8),
        ]),
        createPlayer("bot-1", customBotHand),
      ];
      const publicCards = createTestPublicCards();

      const memory = initBotMemory(
        "bot-1",
        customBotHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      const currentChain = [
        createCard("5-x", 5, true),
        createCard("5-y", 5, true),
      ];
      const decision = makeBotDecision(memory, currentChain, players, publicCards);

      // The bot knows its tail is 5 and should reveal it.
      expect(decision.action).toBe("reveal-player-card");
      expect(decision.playerId).toBe("bot-1");
      expect(decision.minMax).toBe("max");
      expect(decision.confidence).toBe(1.0);
    });

    test("avoids revealing known mismatches", () => {
      const players = createTestPlayers();
      const publicCards = createTestPublicCards();
      const botHand = players[1].hand;

      let memory = initBotMemory(
        "bot-1",
        botHand,
        players,
        publicCards,
        { min: 1, max: 12 }
      );

      // me's head is known to be 2.
      const meHeadId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
      memory = updateMemoryOnReveal(memory, meHeadId, 2, {
        type: "player",
        playerId: "me",
      });

      const currentChain = [
        createCard("5-a", 5, true),
        createCard("5-b", 5, true),
      ];
      const decision = makeBotDecision(memory, currentChain, players, publicCards);

      // Do not choose the head known to be 2.
      if (
        decision.action === "reveal-player-card" &&
        decision.playerId === "me"
      ) {
        expect(decision.minMax).not.toBe("min");
      }
    });
  });
});

// ==================== Number Range Tests ====================

describe("getNumberRangeForPlayerCount", () => {
  test("excludes 11 and 12 for two players", () => {
    expect(getNumberRangeForPlayerCount(2)).toEqual({ min: 1, max: 10 });
  });

  test("excludes 12 for three players", () => {
    expect(getNumberRangeForPlayerCount(3)).toEqual({ min: 1, max: 11 });
  });

  test("uses all numbers for four to six players", () => {
    expect(getNumberRangeForPlayerCount(4)).toEqual({ min: 1, max: 12 });
    expect(getNumberRangeForPlayerCount(5)).toEqual({ min: 1, max: 12 });
    expect(getNumberRangeForPlayerCount(6)).toEqual({ min: 1, max: 12 });
  });
});

// ==================== Edge Cases Tests ====================

describe("Edge Cases", () => {
  test("handles duplicate numbers in a hand correctly", () => {
    const duplicateHand = [
      createCard("3-a", 3),
      createCard("3-b", 3),
      createCard("5-c", 5),
    ];
    const players = [
      createPlayer("me", [createCard("2-a", 2)]),
      createPlayer("bot-1", duplicateHand),
    ];
    const publicCards = createTestPublicCards();

    const memory = initBotMemory(
      "bot-1",
      duplicateHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    // The hand should be recorded correctly.
    expect(memory.myHand).toHaveLength(3);
    expect(memory.myHand[0].number).toBe(3);
    expect(memory.myHand[1].number).toBe(3);

    // Head and tail values should be correct.
    expect(getKnownHeadValue(memory, "bot-1")).toBe(3);
    expect(getKnownTailValue(memory, "bot-1")).toBe(5);
  });

  test("only reveals public cards when every player's hand is empty", () => {
    const emptyPlayers = [
      createPlayer("me", []),
      createPlayer("bot-1", []),
    ];
    const publicCards = createTestPublicCards();

    const memory = initBotMemory(
      "bot-1",
      [],
      emptyPlayers,
      publicCards,
      { min: 1, max: 12 }
    );

    const decision = makeBotDecision(memory, [], emptyPlayers, publicCards);

    expect(decision.action).toBe("reveal-public-card");
  });

  test("uses the next card as the new head after removing the old head", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    let memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    // Reveal me's head card as 2.
    const meHeadId = memory.otherPlayersHands.get("me")!.cards[0].cardId;
    memory = updateMemoryOnReveal(memory, meHeadId, 2, {
      type: "player",
      playerId: "me",
    });
    expect(getKnownHeadValue(memory, "me")).toBe(2);

    // Collect the 2s.
    memory = updateMemoryOnCollect(memory, "someone", 2);

    // The old head is removed and the new head is unknown.
    expect(getKnownHeadValue(memory, "me")).toBeNull();
  });

  test("getAllPossibleActions returns all possible actions", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    const actions = getAllPossibleActions(memory, players, publicCards);

    // Include actions for players' heads and tails and for public cards.
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.action === "reveal-player-card")).toBe(true);
    expect(actions.some((a) => a.action === "reveal-public-card")).toBe(true);
  });

  test("evaluateAllActions returns sorted candidate actions", () => {
    const players = createTestPlayers();
    const publicCards = createTestPublicCards();
    const botHand = players[1].hand;

    const memory = initBotMemory(
      "bot-1",
      botHand,
      players,
      publicCards,
      { min: 1, max: 12 }
    );

    const candidates = evaluateAllActions(memory, [], players, publicCards);

    expect(candidates.length).toBeGreaterThan(0);
    // Sort by expected payoff.
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1].expectedValue).toBeGreaterThanOrEqual(
        candidates[i].expectedValue
      );
    }
  });
});
