# Bot Logic Implementation Plan

## 1. Overview

This document describes the implementation plan for hard-mode bots in NANA. Bots will use perfect memory and inference to maximize their win rate.

## 2. Data Structure Design

### 2.1 Design Principles

Use a **raw data + derived calculations** design:

- **Raw data**: store only fundamental facts (hand arrays, public-card arrays, collection records).
- **Derived calculations**: compute knownHeadValue, knownTailValue, excludedNumbers, and similar values using pure functions.

Benefits:

1. **No redundant data** - maintain one copy of the raw data to avoid inconsistencies.
2. **Single source of truth** - compute derived data so it stays consistent with the facts.
3. **Easy maintenance** - updating raw data does not require synchronizing several fields.
4. **Intuitive representation** - the data structures closely reflect the actual game state.

### 2.2 Raw Data Structure (`BotMemory`)

```typescript
// src/lib/bot-logic.ts

/**
 * A card slot represents a card at a position, with a known or unknown value.
 */
interface CardSlot {
  cardId: string;
  number: number | null; // null means unknown.
}

/**
 * A player's hand as remembered from the bot's perspective.
 * Sorted ascending; known cards have a number, unknown cards have null.
 */
interface PlayerHandMemory {
  playerId: string;
  cards: CardSlot[]; // Sorted hand slots.
}

/**
 * Bot memory stores only raw facts.
 */
interface BotMemory {
  botId: string;

  // The bot's own hand (fully known).
  myHand: CardSlot[];

  // Memories of other players' hands.
  otherPlayersHands: Map<string, PlayerHandMemory>;

  // Public cards, both known and unknown.
  publicCards: CardSlot[];

  // Collected sets: playerId -> list of collected numbers.
  collectedSets: Map<string, number[]>;

  // Number range used in the game, based on player count.
  numberRange: { min: number; max: number };
}
```

### 2.3 Derived Calculation Functions

```typescript
/**
 * Get the player's known head value (lowest end).
 * Return its value if revealed and not yet removed; otherwise null.
 */
function getKnownHeadValue(memory: BotMemory, playerId: string): number | null;

/**
 * Get the player's known tail value (highest end).
 */
function getKnownTailValue(memory: BotMemory, playerId: string): number | null;

/**
 * Get the player's current hand size.
 */
function getHandSize(memory: BotMemory, playerId: string): number;

/**
 * Get the number of copies still unaccounted for globally.
 * Calculation: 3 minus collected copies minus copies at known locations.
 */
function getGlobalRemainingCount(
  memory: BotMemory,
  targetNumber: number
): number;

/**
 * Get the numbers excluded from a player's hand.
 * Infer from head/tail constraints: a head of 5 excludes 1 through 4.
 */
function getExcludedNumbers(memory: BotMemory, playerId: string): Set<number>;

/**
 * Get the number of unknown public cards.
 */
function getUnknownPublicCount(memory: BotMemory): number;

/**
 * Get the number of known public copies of a number.
 */
function getKnownPublicCountForNumber(
  memory: BotMemory,
  targetNumber: number
): number;
```

### 2.4 Bot Decision Result (`BotDecision`)

```typescript
interface BotDecision {
  action: "reveal-player-card" | "reveal-public-card";
  playerId?: string; // Target player ID when revealing a player's card.
  minMax?: "min" | "max"; // Reveal the head or tail.
  cardId?: string; // Public card ID when revealing a public card.
  confidence: number; // Decision confidence from 0 to 1.
  reasoning: string; // Explanation for debugging.
}
```

## 3. Core Function Design

### 3.1 Memory Initialization

```typescript
function initBotMemory(
  botId: string,
  botHand: Card[],
  players: Player[],
  publicCards: Card[],
  numberRange: { min: number; max: number }
): BotMemory;
```

Initialization logic:

```typescript
function initBotMemory(...): BotMemory {
  // 1. Convert the bot's fully known hand to CardSlot[].
  const myHand: CardSlot[] = botHand.map((c) => ({
    cardId: c.id,
    number: c.number, // Fully known.
  }));

  // 2. Only the size of other players' hands is known, not their values.
  const otherPlayersHands = new Map<string, PlayerHandMemory>();
  for (const player of players) {
    if (player.id !== botId) {
      otherPlayersHands.set(player.id, {
        playerId: player.id,
        cards: player.hand.map((c) => ({
          cardId: c.id,
          number: null, // Unknown.
        })),
      });
    }
  }

  // 3. All public cards are initially unknown.
  const publicCardsSlots: CardSlot[] = publicCards.map((c) => ({
    cardId: c.id,
    number: null,
  }));

  return {
    botId,
    myHand,
    otherPlayersHands,
    publicCards: publicCardsSlots,
    collectedSets: new Map(),
    numberRange,
  };
}
```

### 3.2 Memory Updates

```typescript
/**
 * Update memory when a card is revealed.
 */
function updateMemoryOnReveal(
  memory: BotMemory,
  revealedCardId: string,
  revealedNumber: number,
  source: { type: "player"; playerId: string } | { type: "public" }
): BotMemory;
```

Update logic:

```typescript
function updateMemoryOnReveal(...): BotMemory {
  // Create a new memory object for an immutable update.
  const newMemory = { ...memory };

  if (source.type === "player") {
    // Update the CardSlot in the corresponding player's hand.
    const playerHand = newMemory.otherPlayersHands.get(source.playerId);
    if (playerHand) {
      const newCards = playerHand.cards.map((slot) =>
        slot.cardId === revealedCardId ? { ...slot, number: revealedNumber } : slot
      );
      newMemory.otherPlayersHands.set(source.playerId, {
        ...playerHand,
        cards: newCards,
      });
    }
  } else {
    // Update the public cards.
    newMemory.publicCards = memory.publicCards.map((slot) =>
      slot.cardId === revealedCardId ? { ...slot, number: revealedNumber } : slot
    );
  }

  return newMemory;
}

/**
 * Update memory when a set of three is collected.
 */
function updateMemoryOnCollect(
  memory: BotMemory,
  collectorId: string,
  collectedNumber: number
): BotMemory;
```

Update logic:

```typescript
function updateMemoryOnCollect(...): BotMemory {
  const newMemory = { ...memory };

  // 1. Record the collected set.
  const newCollectedSets = new Map(memory.collectedSets);
  const existing = newCollectedSets.get(collectorId) || [];
  newCollectedSets.set(collectorId, [...existing, collectedNumber]);
  newMemory.collectedSets = newCollectedSets;

  // 2. Remove matching cards from our own hand.
  newMemory.myHand = memory.myHand.filter((slot) => slot.number !== collectedNumber);

  // 3. Remove matching cards from other players' hands.
  const newOtherHands = new Map<string, PlayerHandMemory>();
  for (const [playerId, hand] of memory.otherPlayersHands) {
    newOtherHands.set(playerId, {
      ...hand,
      cards: hand.cards.filter((slot) => slot.number !== collectedNumber),
    });
  }
  newMemory.otherPlayersHands = newOtherHands;

  // 4. Remove matching public cards.
  newMemory.publicCards = memory.publicCards.filter(
    (slot) => slot.number !== collectedNumber
  );

  return newMemory;
}
```

### 3.3 Derived Calculation Implementation

```typescript
function getKnownHeadValue(memory: BotMemory, playerId: string): number | null {
  if (playerId === memory.botId) {
    // Our own head value is always known.
    return memory.myHand[0]?.number ?? null;
  }
  const hand = memory.otherPlayersHands.get(playerId);
  if (!hand || hand.cards.length === 0) return null;
  // Return the head (first card) value if known.
  return hand.cards[0].number;
}

function getKnownTailValue(memory: BotMemory, playerId: string): number | null {
  if (playerId === memory.botId) {
    return memory.myHand[memory.myHand.length - 1]?.number ?? null;
  }
  const hand = memory.otherPlayersHands.get(playerId);
  if (!hand || hand.cards.length === 0) return null;
  return hand.cards[hand.cards.length - 1].number;
}

function getHandSize(memory: BotMemory, playerId: string): number {
  if (playerId === memory.botId) {
    return memory.myHand.length;
  }
  return memory.otherPlayersHands.get(playerId)?.cards.length ?? 0;
}

function getGlobalRemainingCount(
  memory: BotMemory,
  targetNumber: number
): number {
  let remaining = 3; // Each number starts with three copies.

  // Subtract collected copies.
  for (const collected of memory.collectedSets.values()) {
    if (collected.includes(targetNumber)) {
      return 0; // Already collected; no copies remain.
    }
  }

  // Subtract copies in our own hand.
  remaining -= memory.myHand.filter((s) => s.number === targetNumber).length;

  // Subtract known copies in other players' hands.
  for (const hand of memory.otherPlayersHands.values()) {
    remaining -= hand.cards.filter((s) => s.number === targetNumber).length;
  }

  // Subtract known public copies.
  remaining -= memory.publicCards.filter(
    (s) => s.number === targetNumber
  ).length;

  return Math.max(0, remaining);
}

function getExcludedNumbers(memory: BotMemory, playerId: string): Set<number> {
  const excluded = new Set<number>();
  const headValue = getKnownHeadValue(memory, playerId);
  const tailValue = getKnownTailValue(memory, playerId);

  // A known head excludes all lower numbers.
  if (headValue !== null) {
    for (let n = memory.numberRange.min; n < headValue; n++) {
      excluded.add(n);
    }
  }

  // A known tail excludes all higher numbers.
  if (tailValue !== null) {
    for (let n = tailValue + 1; n <= memory.numberRange.max; n++) {
      excluded.add(n);
    }
  }

  return excluded;
}
```

### 3.4 Probability Calculation

```typescript
function calculateProbability(
  memory: BotMemory,
  targetNumber: number,
  source:
    | { type: "player"; playerId: string; position: "head" | "tail" }
    | { type: "public" }
): number;
```

Calculation logic:

```typescript
function calculateProbability(...): number {
  // No remaining copies globally means zero probability.
  const globalRemaining = getGlobalRemainingCount(memory, targetNumber);
  if (globalRemaining === 0) return 0;

  if (source.type === "player") {
    const { playerId, position } = source;

    // Get the known value.
    const knownValue =
      position === "head"
        ? getKnownHeadValue(memory, playerId)
        : getKnownTailValue(memory, playerId);

    // A known value gives a certain result.
    if (knownValue !== null) {
      return knownValue === targetNumber ? 1.0 : 0.0;
    }

    // Estimate the probability for an unknown value.
    const excluded = getExcludedNumbers(memory, playerId);
    if (excluded.has(targetNumber)) return 0;

    // Simplified estimate: remaining copies / number of possible values.
    const possibleNumbers =
      memory.numberRange.max - memory.numberRange.min + 1 - excluded.size;
    return Math.min(1, globalRemaining / possibleNumbers);
  } else {
    // Public-area probability.
    const unknownCount = memory.publicCards.filter((s) => s.number === null).length;
    if (unknownCount === 0) return 0;

    // Copies known to be in the public area.
    const knownInPublic = memory.publicCards.filter(
      (s) => s.number === targetNumber
    ).length;

    // Remaining copies that could be in the public area.
    const possibleInPublic = globalRemaining - knownInPublic;
    return possibleInPublic / unknownCount;
  }
}
```

### 3.5 Expected Payoff Calculation

```typescript
interface ActionCandidate {
  decision: BotDecision;
  probability: number; // Probability of revealing the target.
  expectedValue: number; // Expected payoff.
}

function evaluateAllActions(
  memory: BotMemory,
  currentChain: Card[], // Currently revealed cards.
  availableActions: BotDecision[]
): ActionCandidate[];
```

Expected payoff calculation:

- **Empty chain**: EV = P(reveal a valuable number) × expected subsequent success.
- **One T**: EV = P(reveal T) × P(find the third T | two Ts already revealed).
- **Two Ts**: EV = P(reveal T) × 1.0.

### 3.6 Main Decision Function

```typescript
function makeBotDecision(
  memory: BotMemory,
  currentChain: Card[],
  players: Player[],
  publicCards: Card[]
): BotDecision;
```

**Decision process:**

```
1. Enumerate all possible actions
   - Each player's head/tail, including our own, if unrevealed cards remain
   - Every unrevealed public card

2. Decide based on the current chain:

   [Empty chain - flip-1]
   - Prefer our own head card (known value, information advantage)
   - Or find two known locations with matching values

   [One T revealed - flip-2]
   - Find the second T
   - Priority: certainty (1.0) > high probability > low probability
   - If the highest probability is below the threshold, consider abandoning the chain

   [Two Ts revealed - flip-3]
   - Find the third T using the same priorities

3. Calculate each action's expected payoff and choose the highest
```

## 4. Integration with local-game-store.tsx

### 4.1 State Extension

```typescript
export interface LocalGameState {
  // ... existing fields ...

  // Bot memories: each bot maintains its own view of the game.
  botMemories: Map<string, BotMemory>;
}
```

### 4.2 Functions to Modify

#### `startGame()`

```typescript
// Initialize all bot memories after creating the players.
const botMemories = new Map<string, BotMemory>();
const numberRange = getNumberRangeForPlayerCount(totalPlayers);

for (const player of players) {
  if (player.id.startsWith("bot-")) {
    const memory = initBotMemory(
      player.id,
      player.hand, // The bot's own hand (fully known).
      players,
      publicCards,
      numberRange
    );
    botMemories.set(player.id, memory);
  }
}

set((state) => {
  // ... other state updates ...
  state.botMemories = botMemories;
});
```

#### `revealPlayerCard()` and `revealPublicCard()`

```typescript
// Update all bot memories after a card is revealed.
set((draft) => {
  // ... existing reveal logic ...

  // Update all bot memories.
  for (const [botId, memory] of draft.botMemories) {
    draft.botMemories.set(
      botId,
      updateMemoryOnReveal(
        memory,
        card.id, // ID of the revealed card.
        card.number, // Revealed number.
        { type: "player", playerId } // Or { type: "public" }.
      )
    );
  }
});
```

#### `processTurnResult()` - On Successful Collection

```typescript
// Update all bot memories after a successful collection.
set((draft) => {
  // ... existing collection logic ...

  // Update all bot memories.
  for (const [botId, memory] of draft.botMemories) {
    draft.botMemories.set(
      botId,
      updateMemoryOnCollect(memory, currentPlayerId, collectedNumber)
    );
  }
});
```

#### `executeBotTurn()`

```typescript
executeBotTurn: async () => {
  const state = get();
  if (state.gameStage !== "in-game") return;
  if (!state.isCurrentPlayerBot()) return;

  const currentPlayer = state.getCurrentPlayer();
  if (!currentPlayer) return;

  const memory = state.botMemories.get(currentPlayer.id);
  if (!memory) return;

  const revealedCards = state.getRevealedCards();

  // Make a decision using the new data structures.
  const decision = makeBotDecision(
    memory,
    revealedCards,
    state.players,
    state.publicCards
  );

  // Debug logging in development mode.
  if (process.env.NODE_ENV === "development") {
    console.log(`[Bot ${currentPlayer.id}] Decision:`, decision.reasoning);
  }

  // Execute the decision after an animation delay.
  await new Promise((resolve) => setTimeout(resolve, 800));

  if (decision.action === "reveal-player-card" && decision.playerId) {
    get().revealPlayerCard(decision.playerId, decision.minMax || "min");
  } else if (decision.action === "reveal-public-card" && decision.cardId) {
    get().revealPublicCard(decision.cardId);
  }
};
```

### 4.3 Helper Functions

```typescript
// Determine the number range from the player count.
function getNumberRangeForPlayerCount(playerCount: number): {
  min: number;
  max: number;
} {
  switch (playerCount) {
    case 2:
      return { min: 1, max: 10 }; // Remove 11 and 12 for two players.
    case 3:
      return { min: 1, max: 11 }; // Remove 12 for three players.
    default:
      return { min: 1, max: 12 }; // Use all numbers for four to six players.
  }
}
```

## 5. Test Scenarios

### 5.1 Unit Tests - Memory Initialization and Raw Data

#### Test File: `src/lib/__tests__/bot-logic.test.ts`

```typescript
describe("BotMemory Initialization", () => {
  const players = [
    { id: "me", hand: createCards(7) },
    { id: "bot-1", hand: createCards(7) },
    { id: "bot-2", hand: createCards(7) },
  ];
  const publicCards = createCards(8);

  test("initializes the bot's own hand with fully known values", () => {
    const botHand = [
      { id: "2-a", number: 2, isRevealed: false },
      { id: "5-b", number: 5, isRevealed: false },
      { id: "8-c", number: 8, isRevealed: false },
    ];
    const memory = initBotMemory("bot-1", botHand, players, publicCards, {
      min: 1,
      max: 12,
    });

    expect(memory.myHand).toHaveLength(3);
    expect(memory.myHand[0]).toEqual({ cardId: "2-a", number: 2 });
    expect(memory.myHand[1]).toEqual({ cardId: "5-b", number: 5 });
    expect(memory.myHand[2]).toEqual({ cardId: "8-c", number: 8 });
  });

  test("initializes other players' hands with unknown values", () => {
    const memory = initBotMemory("bot-1", botHand, players, publicCards, {
      min: 1,
      max: 12,
    });

    const meHand = memory.otherPlayersHands.get("me");
    expect(meHand?.cards).toHaveLength(7);
    expect(meHand?.cards.every((slot) => slot.number === null)).toBe(true);
  });

  test("initializes public cards with unknown values", () => {
    const memory = initBotMemory("bot-1", botHand, players, publicCards, {
      min: 1,
      max: 12,
    });

    expect(memory.publicCards).toHaveLength(8);
    expect(memory.publicCards.every((slot) => slot.number === null)).toBe(true);
  });
});
```

### 5.2 Unit Tests - Memory Updates

```typescript
describe("Memory Update on Reveal", () => {
  test("updates the matching slot when a player's card is revealed", () => {
    let memory = initBotMemory(...);
    const cardId = memory.otherPlayersHands.get("me")?.cards[0].cardId;

    memory = updateMemoryOnReveal(memory, cardId, 3, { type: "player", playerId: "me" });

    expect(memory.otherPlayersHands.get("me")?.cards[0].number).toBe(3);
  });

  test("updates the matching slot when a public card is revealed", () => {
    let memory = initBotMemory(...);
    const cardId = memory.publicCards[0].cardId;

    memory = updateMemoryOnReveal(memory, cardId, 7, { type: "public" });

    expect(memory.publicCards[0].number).toBe(7);
  });

  test("updates immutably by returning a new object", () => {
    const memory = initBotMemory(...);
    const newMemory = updateMemoryOnReveal(memory, cardId, 3, { type: "public" });

    expect(newMemory).not.toBe(memory);
    expect(newMemory.publicCards).not.toBe(memory.publicCards);
  });
});

describe("Memory Update on Collect", () => {
  test("removes a collected number from every location", () => {
    let memory = initBotMemory(...);
    // Assume memory.myHand contains one 5.
    const initialMyHandLength = memory.myHand.length;

    memory = updateMemoryOnCollect(memory, "me", 5);

    // The 5 is removed from its own hand.
    expect(memory.myHand.filter((s) => s.number === 5)).toHaveLength(0);
    // The collection record is updated.
    expect(memory.collectedSets.get("me")).toContain(5);
  });

  test("removes known copies of a collected number from other players' hands", () => {
    let memory = initBotMemory(...);
    // Reveal a card first so its value is known.
    memory = updateMemoryOnReveal(memory, cardId, 5, { type: "player", playerId: "bot-2" });

    memory = updateMemoryOnCollect(memory, "me", 5);

    // The known 5 is removed from bot-2's hand.
    const bot2Cards = memory.otherPlayersHands.get("bot-2")?.cards;
    expect(bot2Cards?.find((s) => s.number === 5)).toBeUndefined();
  });
});
```

### 5.3 Unit Tests - Derived Calculations

```typescript
describe("Derived Calculations", () => {
  describe("getKnownHeadValue / getKnownTailValue", () => {
    test("always knows its own head and tail values", () => {
      const memory = initBotMemory("bot-1", botHand, ...);

      expect(getKnownHeadValue(memory, "bot-1")).toBe(2); // Assume the lowest card is 2.
      expect(getKnownTailValue(memory, "bot-1")).toBe(8); // Assume the highest card is 8.
    });

    test("returns null for other players' unrevealed head and tail values", () => {
      const memory = initBotMemory(...);

      expect(getKnownHeadValue(memory, "me")).toBeNull();
      expect(getKnownTailValue(memory, "me")).toBeNull();
    });

    test("returns the head value after it is revealed", () => {
      let memory = initBotMemory(...);
      const headCardId = memory.otherPlayersHands.get("me")?.cards[0].cardId;
      memory = updateMemoryOnReveal(memory, headCardId, 3, { type: "player", playerId: "me" });

      expect(getKnownHeadValue(memory, "me")).toBe(3);
    });
  });

  describe("getHandSize", () => {
    test("returns the correct hand size", () => {
      const memory = initBotMemory(...);

      expect(getHandSize(memory, "bot-1")).toBe(3); // The bot itself.
      expect(getHandSize(memory, "me")).toBe(7); // Another player.
    });

    test("reduces the hand size after collection", () => {
      let memory = initBotMemory(...);
      const before = getHandSize(memory, "bot-1");

      memory = updateMemoryOnCollect(memory, "me", 5); // Assume the bot has one 5.

      expect(getHandSize(memory, "bot-1")).toBe(before - 1);
    });
  });

  describe("getGlobalRemainingCount", () => {
    test("initially counts three copies minus those in its own hand", () => {
      // Bot hand: [2, 5, 8].
      const memory = initBotMemory("bot-1", botHand, ...);

      expect(getGlobalRemainingCount(memory, 2)).toBe(2); // 3-1
      expect(getGlobalRemainingCount(memory, 3)).toBe(3); // Unknown locations.
    });

    test("returns 0 remaining copies after a number is collected", () => {
      let memory = initBotMemory(...);
      memory = updateMemoryOnCollect(memory, "me", 5);

      expect(getGlobalRemainingCount(memory, 5)).toBe(0);
    });
  });

  describe("getExcludedNumbers", () => {
    test("excludes numbers below the known head value", () => {
      let memory = initBotMemory(...);
      // Reveal me's head card as 5.
      memory = updateMemoryOnReveal(memory, headCardId, 5, { type: "player", playerId: "me" });

      const excluded = getExcludedNumbers(memory, "me");
      expect(excluded.has(1)).toBe(true);
      expect(excluded.has(4)).toBe(true);
      expect(excluded.has(5)).toBe(false); // Do not exclude 5 itself.
    });

    test("excludes numbers above the known tail value", () => {
      let memory = initBotMemory(...);
      // Reveal me's tail card as 9.
      memory = updateMemoryOnReveal(memory, tailCardId, 9, { type: "player", playerId: "me" });

      const excluded = getExcludedNumbers(memory, "me");
      expect(excluded.has(10)).toBe(true);
      expect(excluded.has(12)).toBe(true);
      expect(excluded.has(9)).toBe(false);
    });
  });
});
```

### 5.4 Unit Tests - Probability Calculation

```typescript
describe("Probability Calculation", () => {
  test("returns probability 1.0 when the known head matches the target", () => {
    let memory = initBotMemory(...);
    memory = updateMemoryOnReveal(memory, headCardId, 3, { type: "player", playerId: "me" });

    const prob = calculateProbability(memory, 3, { type: "player", playerId: "me", position: "head" });
    expect(prob).toBe(1.0);
  });

  test("returns probability 0.0 when the known head differs from the target", () => {
    let memory = initBotMemory(...);
    memory = updateMemoryOnReveal(memory, headCardId, 3, { type: "player", playerId: "me" });

    const prob = calculateProbability(memory, 5, { type: "player", playerId: "me", position: "head" });
    expect(prob).toBe(0.0);
  });

  test("calculates public-area probability correctly", () => {
    let memory = initBotMemory(...);
    // Of eight public cards, reveal one 7.
    memory = updateMemoryOnReveal(memory, publicCardId, 7, { type: "public" });
    // The bot has no 7, and no 7 is known at any other location.

    // Remaining 7s: 3-1=2; unknown public cards: 7.
    // One 7 is known in public, so possible 7s among unknown public cards: 2-1=1.
    const prob = calculateProbability(memory, 7, { type: "public" });
    expect(prob).toBeCloseTo(1 / 7, 2);
  });

  test("returns probability 0 when the target number has been collected", () => {
    let memory = initBotMemory(...);
    memory = updateMemoryOnCollect(memory, "me", 5);

    const prob = calculateProbability(memory, 5, { type: "player", playerId: "me", position: "head" });
    expect(prob).toBe(0);
  });

  test("returns probability 0 when head/tail constraints exclude the target", () => {
    let memory = initBotMemory(...);
    // me's head is 5, so its hand cannot contain 1 through 4.
    memory = updateMemoryOnReveal(memory, headCardId, 5, { type: "player", playerId: "me" });

    const prob = calculateProbability(memory, 3, { type: "player", playerId: "me", position: "tail" });
    expect(prob).toBe(0);
  });
});
```

### 5.5 Unit Tests - Decision Logic

```typescript
describe("Bot Decision Making", () => {
  describe("Empty chain (flip-1)", () => {
    test("prefers its own head card as a starting point", () => {
      const memory = initBotMemory("bot-1", botHand, players, publicCards, ...);
      const decision = makeBotDecision(memory, [], players, publicCards);

      expect(decision.action).toBe("reveal-player-card");
      expect(decision.playerId).toBe("bot-1"); // Itself.
      expect(decision.minMax).toBe("min"); // Head card.
    });

    test("uses knowledge of two locations with the same number", () => {
      let memory = initBotMemory(...);
      // me's head = 4, bot-2's head = 4.
      memory = updateMemoryOnReveal(memory, meHeadId, 4, { type: "player", playerId: "me" });
      memory = updateMemoryOnReveal(memory, bot2HeadId, 4, { type: "player", playerId: "bot-2" });

      const decision = makeBotDecision(memory, [], players, publicCards);

      // Reveal one of the heads known to be 4.
      expect(decision.action).toBe("reveal-player-card");
      expect(["me", "bot-2"]).toContain(decision.playerId);
    });
  });

  describe("One card revealed (flip-2)", () => {
    test("prefers a certain source", () => {
      let memory = initBotMemory(...);
      // me's tail is known to be 6.
      memory = updateMemoryOnReveal(memory, meTailId, 6, { type: "player", playerId: "me" });

      const currentChain = [{ id: "6-a", number: 6, isRevealed: true }];
      const decision = makeBotDecision(memory, currentChain, players, publicCards);

      expect(decision.action).toBe("reveal-player-card");
      expect(decision.playerId).toBe("me");
      expect(decision.minMax).toBe("max");
      expect(decision.confidence).toBe(1.0);
    });

    test("chooses the highest-probability source when no source is certain", () => {
      const memory = initBotMemory(...);
      const currentChain = [{ id: "8-a", number: 8, isRevealed: true }];
      const decision = makeBotDecision(memory, currentChain, players, publicCards);

      expect(decision.confidence).toBeLessThan(1.0);
      expect(decision.confidence).toBeGreaterThan(0);
    });
  });

  describe("Two cards revealed (flip-3)", () => {
    test("immediately selects a certain third card", () => {
      // The bot has a 5 in its hand.
      const botHand = [
        { id: "3-a", number: 3 },
        { id: "5-c", number: 5 },
        { id: "9-a", number: 9 },
      ];
      let memory = initBotMemory("bot-1", botHand, ...);

      const currentChain = [
        { id: "5-a", number: 5, isRevealed: true },
        { id: "5-b", number: 5, isRevealed: true },
      ];
      const decision = makeBotDecision(memory, currentChain, players, publicCards);

      // The bot knows it has a 5 and should reveal its own card.
      expect(decision.action).toBe("reveal-player-card");
      expect(decision.playerId).toBe("bot-1");
    });

    test("avoids revealing known mismatches", () => {
      let memory = initBotMemory(...);
      // me's head is known to be 3.
      memory = updateMemoryOnReveal(memory, meHeadId, 3, { type: "player", playerId: "me" });

      const currentChain = [
        { id: "5-a", number: 5, isRevealed: true },
        { id: "5-b", number: 5, isRevealed: true },
      ];
      const decision = makeBotDecision(memory, currentChain, players, publicCards);

      // Do not choose the head known to be 3.
      if (decision.action === "reveal-player-card" && decision.playerId === "me") {
        expect(decision.minMax).not.toBe("min");
      }
    });
  });
});
```

### 5.6 Integration Tests - Game Flow

```typescript
describe("Bot Game Flow Integration", () => {
  test("the bot can complete a full turn", async () => {
    const store = useLocalGameStore.getState();
    store.setBotCount(1);
    store.startGame();

    // Simulate the start of the bot's turn.
    store.nextTurn();

    // Wait for the bot to act.
    await waitFor(
      () => {
        const state = useLocalGameStore.getState();
        return state.turnPhase === "failed" || state.turnPhase === "flip-1";
      },
      { timeout: 5000 }
    );

    // Verify that the game state remains valid.
    const finalState = useLocalGameStore.getState();
    expect(finalState.gameStage).toBe("in-game");
  });

  test("bot memory updates correctly during play", async () => {
    const store = useLocalGameStore.getState();
    store.setBotCount(2);
    store.startGame();

    // The human player reveals a card.
    store.revealPlayerCard("me", "min");

    await waitFor(() => {
      const state = useLocalGameStore.getState();
      const bot1Memory = state.botMemories.get("bot-1");
      // Check whether me's head slot has been updated.
      const meHand = bot1Memory?.otherPlayersHands.get("me");
      return meHand?.cards[0].number !== null;
    });

    const state = useLocalGameStore.getState();
    const bot1Memory = state.botMemories.get("bot-1");
    const meHeadValue = getKnownHeadValue(bot1Memory, "me");
    expect(meHeadValue).not.toBeNull();
  });

  test("the bot continues its turn after collecting a set of three", async () => {
    const store = useLocalGameStore.getState();
    // ... set up a specific game state that guarantees bot success ...

    await store.executeBotTurn();

    const state = useLocalGameStore.getState();
    if (state.turnPhase === "flip-1") {
      // The bot succeeded and continues its turn.
      expect(state.isCurrentPlayerBot()).toBe(true);
    }
  });
});
```

### 5.7 Edge Case Tests

```typescript
describe("Edge Cases", () => {
  test("does not target a number with only one remaining copy", () => {
    // The bot holds [3]; only one 3 remains globally, so a set is impossible.
    const botHand = [{ id: "3-a", number: 3, isRevealed: false }];
    const memory = initBotMemory("bot-1", botHand, players, publicCards, ...);

    // getGlobalRemainingCount should return the correct value.
    expect(getGlobalRemainingCount(memory, 3)).toBe(2); // 3-1=2

    // Assume another player collects a set of 3s.
    const memory2 = updateMemoryOnCollect(memory, "me", 3);
    expect(getGlobalRemainingCount(memory2, 3)).toBe(0);

    // The decision should not target 3.
    const decision = makeBotDecision(memory2, [], players, publicCards);
    // ... verify that it does not try to reveal a 3 ...
  });

  test("handles duplicate numbers in a hand correctly", () => {
    const botHand = [
      { id: "3-a", number: 3, isRevealed: false },
      { id: "3-b", number: 3, isRevealed: false },
      { id: "5-c", number: 5, isRevealed: false },
    ];
    const memory = initBotMemory("bot-1", botHand, players, publicCards, ...);

    // The hand should be recorded correctly.
    expect(memory.myHand).toHaveLength(3);
    expect(memory.myHand[0].number).toBe(3);
    expect(memory.myHand[1].number).toBe(3);

    // Head and tail values should be correct.
    expect(getKnownHeadValue(memory, "bot-1")).toBe(3);
    expect(getKnownTailValue(memory, "bot-1")).toBe(5);
  });

  test("only reveals public cards when every player's hand is empty", () => {
    // Create a state in which all hands are empty.
    const emptyPlayers = players.map((p) => ({ ...p, hand: [] }));
    const memory = initBotMemory("bot-1", [], emptyPlayers, publicCards, ...);

    const decision = makeBotDecision(memory, [], emptyPlayers, publicCards);

    expect(decision.action).toBe("reveal-public-card");
  });

  test("only reveals players' cards when the public area is empty", () => {
    const memory = initBotMemory("bot-1", botHand, players, [], ...);

    const decision = makeBotDecision(memory, [], players, []);

    expect(decision.action).toBe("reveal-player-card");
  });

  test("uses the next card as the new head after removing the old head", () => {
    let memory = initBotMemory(...);
    // Reveal me's head card as 3.
    memory = updateMemoryOnReveal(memory, meHeadId, 3, { type: "player", playerId: "me" });
    expect(getKnownHeadValue(memory, "me")).toBe(3);

    // Collect the 3s.
    memory = updateMemoryOnCollect(memory, "someone", 3);

    // The old head is removed and the new head is unknown.
    expect(getKnownHeadValue(memory, "me")).toBeNull();
  });
});
```

## 6. Implementation Steps

### Phase 1: Basic Data Structures (bot-logic.ts)

1. Define the `BotMemory`, `PlayerKnowledge`, and `BotDecision` interfaces.
2. Implement `initBotMemory()`.
3. Write the corresponding unit tests.

### Phase 2: Memory Update Logic (bot-logic.ts)

1. Implement `updateMemoryOnReveal()`.
2. Implement `updateMemoryOnCollect()`.
3. Implement constraint inference (head/tail constraints and excluded numbers).
4. Write the corresponding unit tests.

### Phase 3: Probability Calculation (bot-logic.ts)

1. Implement `calculateProbability()`.
2. Implement public-area probability calculations.
3. Implement player-end probability calculations with constraints.
4. Write the corresponding unit tests.

### Phase 4: Decision Engine (bot-logic.ts)

1. Implement expected payoff calculation in `evaluateAction()`.
2. Implement the main decision function, `makeBotDecision()`.
3. Implement the strategies at each priority level.
4. Write the corresponding unit tests.

### Phase 5: Store Integration (local-game-store.tsx)

1. Add `botMemories` to the state.
2. Update `startGame()` to initialize memory.
3. Update `revealPlayerCard()` and `revealPublicCard()` to update memory.
4. Update `processTurnResult()` to update memory on collection.
5. Complete `executeBotTurn()` by calling the decision logic.
6. Write integration tests.

### Phase 6: Tuning and Completion

1. Add decision logging in development mode.
2. Optimize performance if needed.
3. Handle edge cases.
4. Run end-to-end tests.

## 7. Considerations

1. **Immutable data**: use Immer to ensure immutable state updates.
2. **Map/Set support**: `enableMapSet()` is already enabled, allowing their use with Immer.
3. **Asynchronous handling**: delay bot actions appropriately so users can see the animations.
4. **Memory management**: reveal history may need a length limit or cleanup when the game ends.
5. **Probability precision**: use appropriate numeric precision to avoid floating-point comparison issues.

## 8. Exported Interface

```typescript
// Exports from src/lib/bot-logic.ts

export {
  // Types
  CardSlot,
  PlayerHandMemory,
  BotMemory,
  BotDecision,
  ActionCandidate,

  // Memory Management
  initBotMemory,
  updateMemoryOnReveal,
  updateMemoryOnCollect,

  // Derived Calculations (Pure Functions)
  getKnownHeadValue,
  getKnownTailValue,
  getHandSize,
  getGlobalRemainingCount,
  getExcludedNumbers,
  getUnknownPublicCount,

  // Decision Making
  calculateProbability,
  evaluateAllActions,
  makeBotDecision,
};
```

## 9. Design Summary

### Data Flow

```
Game event → updateMemoryOnReveal / updateMemoryOnCollect → Update raw data
                                                              ↓
                                         Derived calculations (getKnownHeadValue, etc.)
                                                              ↓
                                           calculateProbability → makeBotDecision
```

### Benefits

1. **Data consistency**: one copy of raw data, with computed derived values, avoids inconsistencies.
2. **Easy debugging**: inspect the raw data structures directly to understand the bot's perspective.
3. **Easy testing**: derived calculations are pure functions that are straightforward to unit-test.
4. **Easy extension**: add derived calculations without changing the data structures.
