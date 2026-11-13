import { Card, Player } from "@/types";
import { sortByIdAsc, sortByIdDesc } from "@/lib/game-helper";

// ==================== Types ====================

/**
 * A card slot represents a card at a position; its value may be known or unknown.
 */
export interface CardSlot {
  cardId: string;
  number: number | null; // null means unknown.
}

/**
 * A player's hand as remembered from the bot's perspective.
 * Sorted in ascending order; known cards have a number, unknown cards have null.
 */
export interface PlayerHandMemory {
  playerId: string;
  cards: CardSlot[]; // Sorted hand slots.
}

/**
 * Bot memory stores only raw facts.
 */
export interface BotMemory {
  botId: string;

  // The bot's own hand (fully known).
  myHand: CardSlot[];

  // Memories of other players' hands.
  otherPlayersHands: Map<string, PlayerHandMemory>;

  // Public cards, both known and unknown.
  publicCards: CardSlot[];

  // Collected sets: playerId -> list of collected numbers.
  collectedSets: Map<string, number[]>;

  // Number range used in this game, based on player count.
  numberRange: { min: number; max: number };
}

/**
 * The result of a bot decision.
 */
export interface BotDecision {
  action: "reveal-player-card" | "reveal-public-card";
  playerId?: string; // Target player ID when revealing a player's card.
  minMax?: "min" | "max"; // Reveal the lowest or highest card.
  cardId?: string; // Public card ID when revealing a public card.
  confidence: number; // Decision confidence from 0 to 1.
  reasoning: string; // Explanation for debugging.
}

/**
 * A candidate action.
 */
export interface ActionCandidate {
  decision: BotDecision;
  probability: number; // Probability of revealing the target.
  expectedValue: number; // Expected payoff.
}

// ==================== Memory Management ====================

/**
 * Determine the number range from the player count.
 */
export function getNumberRangeForPlayerCount(playerCount: number): {
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

/**
 * Initialize bot memory.
 */
export function initBotMemory(
  botId: string,
  botHand: Card[],
  players: Player[],
  publicCards: Card[],
  numberRange: { min: number; max: number }
): BotMemory {
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

/**
 * Update memory when a card is revealed.
 */
export function updateMemoryOnReveal(
  memory: BotMemory,
  revealedCardId: string,
  revealedNumber: number,
  source: { type: "player"; playerId: string } | { type: "public" }
): BotMemory {
  // Create a new memory object for an immutable update.
  const newMemory = { ...memory };

  if (source.type === "player") {
    if (source.playerId === memory.botId) {
      // Record a revealed card from our own hand, even though its value is known.
      newMemory.myHand = memory.myHand.map((slot) =>
        slot.cardId === revealedCardId
          ? { ...slot, number: revealedNumber }
          : slot
      );
    } else {
      // Update the CardSlot in the corresponding player's hand.
      const playerHand = memory.otherPlayersHands.get(source.playerId);
      if (playerHand) {
        const newOtherHands = new Map(memory.otherPlayersHands);
        const newCards = playerHand.cards.map((slot) =>
          slot.cardId === revealedCardId
            ? { ...slot, number: revealedNumber }
            : slot
        );
        newOtherHands.set(source.playerId, {
          ...playerHand,
          cards: newCards,
        });
        newMemory.otherPlayersHands = newOtherHands;
      }
    }
  } else {
    // Update the public cards.
    newMemory.publicCards = memory.publicCards.map((slot) =>
      slot.cardId === revealedCardId
        ? { ...slot, number: revealedNumber }
        : slot
    );
  }

  return newMemory;
}

/**
 * Update memory when a set of three is collected.
 */
export function updateMemoryOnCollect(
  memory: BotMemory,
  collectorId: string,
  collectedNumber: number
): BotMemory {
  const newMemory = { ...memory };

  // 1. Record the collected set.
  const newCollectedSets = new Map(memory.collectedSets);
  const existing = newCollectedSets.get(collectorId) || [];
  newCollectedSets.set(collectorId, [...existing, collectedNumber]);
  newMemory.collectedSets = newCollectedSets;

  // 2. Remove matching cards from our own hand.
  newMemory.myHand = memory.myHand.filter(
    (slot) => slot.number !== collectedNumber
  );

  // 3. Remove matching cards from other players' hands.
  const newOtherHands = new Map<string, PlayerHandMemory>();
  for (const [playerId, hand] of Array.from(memory.otherPlayersHands)) {
    newOtherHands.set(playerId, {
      ...hand,
      cards: hand.cards.filter(
        (slot: CardSlot) => slot.number !== collectedNumber
      ),
    });
  }
  newMemory.otherPlayersHands = newOtherHands;

  // 4. Remove matching public cards.
  newMemory.publicCards = memory.publicCards.filter(
    (slot) => slot.number !== collectedNumber
  );

  return newMemory;
}

// ==================== Derived Calculations ====================

/**
 * Get the player's known head value (lowest end).
 * Return its value if the head was revealed and has not been removed; otherwise null.
 */
export function getKnownHeadValue(
  memory: BotMemory,
  playerId: string
): number | null {
  if (playerId === memory.botId) {
    // Our own head value is always known.
    return memory.myHand[0]?.number ?? null;
  }
  const hand = memory.otherPlayersHands.get(playerId);
  if (!hand || hand.cards.length === 0) return null;
  // Return the head (first card) value if known.
  return hand.cards[0].number;
}

/**
 * Get the player's known tail value (highest end).
 */
export function getKnownTailValue(
  memory: BotMemory,
  playerId: string
): number | null {
  if (playerId === memory.botId) {
    return memory.myHand[memory.myHand.length - 1]?.number ?? null;
  }
  const hand = memory.otherPlayersHands.get(playerId);
  if (!hand || hand.cards.length === 0) return null;
  return hand.cards[hand.cards.length - 1].number;
}

/**
 * Get the player's current hand size.
 */
export function getHandSize(memory: BotMemory, playerId: string): number {
  if (playerId === memory.botId) {
    return memory.myHand.length;
  }
  return memory.otherPlayersHands.get(playerId)?.cards.length ?? 0;
}

/**
 * Get the number of copies still unaccounted for globally.
 * Calculation: 3 minus collected copies minus copies at known locations.
 */
export function getGlobalRemainingCount(
  memory: BotMemory,
  targetNumber: number
): number {
  let remaining = 3; // Each number starts with three copies.

  // Subtract collected copies.
  for (const collected of Array.from(memory.collectedSets.values())) {
    if (collected.includes(targetNumber)) {
      return 0; // Already collected; no copies remain.
    }
  }

  // Subtract copies in our own hand.
  remaining -= memory.myHand.filter((s) => s.number === targetNumber).length;

  // Subtract known copies in other players' hands.
  for (const hand of Array.from(memory.otherPlayersHands.values())) {
    remaining -= hand.cards.filter(
      (s: CardSlot) => s.number === targetNumber
    ).length;
  }

  // Subtract known public copies.
  remaining -= memory.publicCards.filter(
    (s) => s.number === targetNumber
  ).length;

  return Math.max(0, remaining);
}

/**
 * Get the numbers excluded from a player's hand.
 * Infer from head/tail constraints: a head of 5 excludes 1 through 4.
 */
export function getExcludedNumbers(
  memory: BotMemory,
  playerId: string
): Set<number> {
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

/**
 * Get the number of unknown public cards.
 */
export function getUnknownPublicCount(memory: BotMemory): number {
  return memory.publicCards.filter((s) => s.number === null).length;
}

/**
 * Get the number of known public copies of a number.
 */
export function getKnownPublicCountForNumber(
  memory: BotMemory,
  targetNumber: number
): number {
  return memory.publicCards.filter((s) => s.number === targetNumber).length;
}

// ==================== Probability Calculation ====================

/**
 * Calculate the probability of revealing the target number.
 */
export function calculateProbability(
  memory: BotMemory,
  targetNumber: number,
  source:
    | { type: "player"; playerId: string; position: "head" | "tail" }
    | { type: "public" }
): number {
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
    if (possibleNumbers <= 0) return 0;

    return Math.min(1, globalRemaining / possibleNumbers);
  } else {
    // Public-area probability.
    const unknownCount = memory.publicCards.filter(
      (s) => s.number === null
    ).length;
    if (unknownCount === 0) return 0;

    // Copies known to be in the public area.
    const knownInPublic = memory.publicCards.filter(
      (s) => s.number === targetNumber
    ).length;

    // Remaining copies that could be in the public area.
    const possibleInPublic = globalRemaining - knownInPublic;
    if (possibleInPublic <= 0) return 0;

    return Math.min(1, possibleInPublic / unknownCount);
  }
}

// ==================== Action Evaluation ====================

/**
 * Get all possible actions.
 */
export function getAllPossibleActions(
  memory: BotMemory,
  players: Player[],
  publicCards: Card[]
): BotDecision[] {
  const actions: BotDecision[] = [];

  // Iterate over all players, including ourselves.
  for (const player of players) {
    const handSize = getHandSize(memory, player.id);
    if (handSize === 0) continue;

    // Check for an unrevealed head card.
    let hasUnrevealedHead = false;
    let hasUnrevealedTail = false;

    if (player.id === memory.botId) {
      // Our own cards.
      hasUnrevealedHead = memory.myHand.length > 0;
      hasUnrevealedTail = memory.myHand.length > 0;
    } else {
      const hand = memory.otherPlayersHands.get(player.id);
      if (hand && hand.cards.length > 0) {
        // Check for unrevealed cards in the actual game state.
        const playerInGame = players.find((p) => p.id === player.id);
        if (playerInGame) {
          const unrevealedCards = playerInGame.hand.filter(
            (c) => !c.isRevealed
          );
          hasUnrevealedHead = unrevealedCards.some((c) => {
            // Find this card's position in the sorted hand.
            const sortedUnrevealed = [...unrevealedCards].sort(sortByIdAsc);
            return c.id === sortedUnrevealed[0]?.id;
          });
          hasUnrevealedTail = unrevealedCards.some((c) => {
            const sortedUnrevealed = [...unrevealedCards].sort(sortByIdDesc);
            return c.id === sortedUnrevealed[0]?.id;
          });
        }
      }
    }

    if (hasUnrevealedHead) {
      actions.push({
        action: "reveal-player-card",
        playerId: player.id,
        minMax: "min",
        confidence: 0,
        reasoning: "",
      });
    }

    if (hasUnrevealedTail && handSize > 1) {
      actions.push({
        action: "reveal-player-card",
        playerId: player.id,
        minMax: "max",
        confidence: 0,
        reasoning: "",
      });
    }
  }

  // Iterate over unrevealed public cards.
  for (const card of publicCards) {
    if (!card.isRevealed && card.id) {
      actions.push({
        action: "reveal-public-card",
        cardId: card.id,
        confidence: 0,
        reasoning: "",
      });
    }
  }

  return actions;
}

/**
 * Find two known locations with the same number.
 */
function findKnownPairOpportunity(
  memory: BotMemory,
  players: Player[]
): {
  number: number;
  sources: Array<{ playerId: string; position: "head" | "tail" }>;
} | null {
  const knownValues: Array<{
    number: number;
    playerId: string;
    position: "head" | "tail";
  }> = [];

  // Gather all known head and tail values.
  for (const player of players) {
    const headValue = getKnownHeadValue(memory, player.id);
    const tailValue = getKnownTailValue(memory, player.id);

    if (headValue !== null) {
      knownValues.push({
        number: headValue,
        playerId: player.id,
        position: "head",
      });
    }
    if (tailValue !== null && tailValue !== headValue) {
      knownValues.push({
        number: tailValue,
        playerId: player.id,
        position: "tail",
      });
    }
  }

  // Look for two matching numbers.
  for (let i = 0; i < knownValues.length; i++) {
    for (let j = i + 1; j < knownValues.length; j++) {
      if (knownValues[i].number === knownValues[j].number) {
        const num = knownValues[i].number;
        // Ensure this number has not been collected and a third copy remains.
        if (getGlobalRemainingCount(memory, num) >= 1) {
          return {
            number: num,
            sources: [
              {
                playerId: knownValues[i].playerId,
                position: knownValues[i].position,
              },
              {
                playerId: knownValues[j].playerId,
                position: knownValues[j].position,
              },
            ],
          };
        }
      }
    }
  }

  return null;
}

/**
 * Find the best source for the second or third card.
 */
function findBestSourceForNumber(
  memory: BotMemory,
  targetNumber: number,
  players: Player[],
  publicCards: Card[],
  excludeActions: BotDecision[] = []
): ActionCandidate | null {
  const candidates: ActionCandidate[] = [];

  // Check every player's head and tail.
  for (const player of players) {
    const handSize = getHandSize(memory, player.id);
    if (handSize === 0) continue;

    // Check the head.
    const headProb = calculateProbability(memory, targetNumber, {
      type: "player",
      playerId: player.id,
      position: "head",
    });

    if (headProb > 0) {
      const decision: BotDecision = {
        action: "reveal-player-card",
        playerId: player.id,
        minMax: "min",
        confidence: headProb,
        reasoning: `Probability of ${targetNumber} at ${player.id}'s head: ${(headProb * 100).toFixed(1)}%`,
      };

      // Check whether the number is excluded.
      const isExcluded = excludeActions.some(
        (a) =>
          a.action === decision.action &&
          a.playerId === decision.playerId &&
          a.minMax === decision.minMax
      );

      if (!isExcluded) {
        candidates.push({
          decision,
          probability: headProb,
          expectedValue: headProb,
        });
      }
    }

    // Check the tail if the hand contains multiple cards.
    if (handSize > 1) {
      const tailProb = calculateProbability(memory, targetNumber, {
        type: "player",
        playerId: player.id,
        position: "tail",
      });

      if (tailProb > 0) {
        const decision: BotDecision = {
          action: "reveal-player-card",
          playerId: player.id,
          minMax: "max",
          confidence: tailProb,
          reasoning: `Probability of ${targetNumber} at ${player.id}'s tail: ${(tailProb * 100).toFixed(1)}%`,
        };

        const isExcluded = excludeActions.some(
          (a) =>
            a.action === decision.action &&
            a.playerId === decision.playerId &&
            a.minMax === decision.minMax
        );

        if (!isExcluded) {
          candidates.push({
            decision,
            probability: tailProb,
            expectedValue: tailProb,
          });
        }
      }
    }
  }

  // Check the public area.
  const publicProb = calculateProbability(memory, targetNumber, {
    type: "public",
  });
  if (publicProb > 0) {
    // Find an unrevealed public card.
    const unrevealedPublic = publicCards.find((c) => !c.isRevealed && c.id);
    if (unrevealedPublic) {
      const decision: BotDecision = {
        action: "reveal-public-card",
        cardId: unrevealedPublic.id,
        confidence: publicProb,
        reasoning: `Probability of ${targetNumber} in public: ${(publicProb * 100).toFixed(1)}%`,
      };

      const isExcluded = excludeActions.some(
        (a) => a.action === decision.action && a.cardId === decision.cardId
      );

      if (!isExcluded) {
        candidates.push({
          decision,
          probability: publicProb,
          expectedValue: publicProb,
        });
      }
    }
  }

  // Sort by probability and return the highest.
  candidates.sort((a, b) => b.probability - a.probability);
  return candidates[0] || null;
}

/**
 * Find the most valuable target number for starting a chain.
 */
function findBestTargetNumber(memory: BotMemory): number | null {
  let bestNumber: number | null = null;
  let bestScore = -1;

  for (let n = memory.numberRange.min; n <= memory.numberRange.max; n++) {
    const remaining = getGlobalRemainingCount(memory, n);
    // At least three copies are needed to collect a set.
    if (remaining < 3) continue;

    // Prefer numbers in our own hand.
    const myCount = memory.myHand.filter((s) => s.number === n).length;
    const score = remaining + myCount * 2; // Give our own cards extra weight.

    if (score > bestScore) {
      bestScore = score;
      bestNumber = n;
    }
  }

  return bestNumber;
}

// ==================== Main Decision Function ====================

/**
 * Main bot decision function.
 */
export function makeBotDecision(
  memory: BotMemory,
  currentChain: Card[],
  players: Player[],
  publicCards: Card[]
): BotDecision {
  const chainLength = currentChain.length;
  const targetNumber = chainLength > 0 ? currentChain[0].number : null;

  // ===== Two cards revealed (flip-3) =====
  if (chainLength === 2 && targetNumber !== null) {
    // Find a third copy of the target number.
    const bestSource = findBestSourceForNumber(
      memory,
      targetNumber,
      players,
      publicCards
    );

    if (bestSource) {
      return {
        ...bestSource.decision,
        reasoning: `[flip-3] Looking for third ${targetNumber}: ${bestSource.decision.reasoning}`,
      };
    }

    // No good option: reveal a random card (the challenge will fail, but a reveal is required).
    return makeExploratoryDecision(
      memory,
      players,
      publicCards,
      "No good option for third card"
    );
  }

  // ===== One card revealed (flip-2) =====
  if (chainLength === 1 && targetNumber !== null) {
    // Find a second copy of the target number.
    const bestSource = findBestSourceForNumber(
      memory,
      targetNumber,
      players,
      publicCards
    );

    if (bestSource && bestSource.probability >= 0.1) {
      return {
        ...bestSource.decision,
        reasoning: `[flip-2] Looking for second ${targetNumber}: ${bestSource.decision.reasoning}`,
      };
    }

    // Low probability: consider giving up by revealing a mismatch to end the turn.
    // Continuing is also possible; hard mode favors taking the risk.
    if (bestSource) {
      return {
        ...bestSource.decision,
        reasoning: `[flip-2] Taking a chance for ${targetNumber}: ${bestSource.decision.reasoning}`,
      };
    }

    return makeExploratoryDecision(
      memory,
      players,
      publicCards,
      "No source for second card"
    );
  }

  // ===== Empty chain (flip-1) =====

  // Strategy 1: look for two known locations with the same number.
  const pairOpp = findKnownPairOpportunity(memory, players);
  if (pairOpp) {
    // Reveal the first known location.
    const firstSource = pairOpp.sources[0];
    return {
      action: "reveal-player-card",
      playerId: firstSource.playerId,
      minMax: firstSource.position === "head" ? "min" : "max",
      confidence: 1.0,
      reasoning: `[flip-1] Found known pair of ${pairOpp.number}, starting with ${firstSource.playerId}'s ${firstSource.position}`,
    };
  }

  // Strategy 2: prefer our own head card as a starting point.
  if (memory.myHand.length > 0) {
    const myHeadNumber = memory.myHand[0].number!;
    const remaining = getGlobalRemainingCount(memory, myHeadNumber);

    if (remaining >= 2) {
      // A set of three is still possible.
      return {
        action: "reveal-player-card",
        playerId: memory.botId,
        minMax: "min",
        confidence: 0.8,
        reasoning: `[flip-1] Starting with my head card (${myHeadNumber}), ${remaining + 1} total remaining`,
      };
    }
  }

  // Strategy 3: find the most valuable target number.
  const bestTarget = findBestTargetNumber(memory);
  if (bestTarget !== null) {
    // Find the best source for this number.
    const bestSource = findBestSourceForNumber(
      memory,
      bestTarget,
      players,
      publicCards
    );

    if (bestSource && bestSource.probability > 0) {
      return {
        ...bestSource.decision,
        reasoning: `[flip-1] Targeting ${bestTarget}: ${bestSource.decision.reasoning}`,
      };
    }
  }

  // Strategy 4: reveal a card to gather information.
  return makeExploratoryDecision(
    memory,
    players,
    publicCards,
    "No clear target, exploring"
  );
}

/**
 * Choose an exploratory action when there is no specific target.
 */
function makeExploratoryDecision(
  memory: BotMemory,
  players: Player[],
  publicCards: Card[],
  reason: string
): BotDecision {
  // Prefer an opponent's head card to gather information.
  for (const player of players) {
    if (player.id === memory.botId) continue;

    const headValue = getKnownHeadValue(memory, player.id);
    if (headValue === null) {
      // The head value is unknown; reveal it.
      const handSize = getHandSize(memory, player.id);
      if (handSize > 0) {
        return {
          action: "reveal-player-card",
          playerId: player.id,
          minMax: "min",
          confidence: 0.3,
          reasoning: `[explore] ${reason}. Revealing ${player.id}'s head for information`,
        };
      }
    }
  }

  // Reveal a public card.
  const unrevealedPublic = publicCards.find((c) => !c.isRevealed && c.id);
  if (unrevealedPublic) {
    return {
      action: "reveal-public-card",
      cardId: unrevealedPublic.id,
      confidence: 0.2,
      reasoning: `[explore] ${reason}. Revealing public card for information`,
    };
  }

  // Reveal our own card as a last resort.
  if (memory.myHand.length > 0) {
    return {
      action: "reveal-player-card",
      playerId: memory.botId,
      minMax: "min",
      confidence: 0.1,
      reasoning: `[explore] ${reason}. Revealing own card as last resort`,
    };
  }

  // No options remain.
  return {
    action: "reveal-public-card",
    cardId: publicCards[0]?.id || "",
    confidence: 0,
    reasoning: `[explore] No valid actions available`,
  };
}

/**
 * Evaluate the expected payoff of every action.
 */
export function evaluateAllActions(
  memory: BotMemory,
  currentChain: Card[],
  players: Player[],
  publicCards: Card[]
): ActionCandidate[] {
  const actions = getAllPossibleActions(memory, players, publicCards);
  const candidates: ActionCandidate[] = [];

  const targetNumber = currentChain.length > 0 ? currentChain[0].number : null;

  for (const action of actions) {
    let probability = 0;
    let expectedValue = 0;

    if (targetNumber !== null) {
      // With a target number, calculate the probability of revealing it.
      if (action.action === "reveal-player-card" && action.playerId) {
        probability = calculateProbability(memory, targetNumber, {
          type: "player",
          playerId: action.playerId,
          position: action.minMax === "min" ? "head" : "tail",
        });
      } else if (action.action === "reveal-public-card") {
        probability = calculateProbability(memory, targetNumber, {
          type: "public",
        });
      }

      // Expected payoff.
      if (currentChain.length === 2) {
        // For the third card, success probability equals expected payoff.
        expectedValue = probability;
      } else if (currentChain.length === 1) {
        // For the second card, account for the chance of subsequent success.
        expectedValue = probability * 0.5; // Simplified estimate.
      }
    } else {
      // An empty chain has exploratory value.
      expectedValue = 0.1; // Base exploratory value.
    }

    candidates.push({
      decision: { ...action, confidence: probability },
      probability,
      expectedValue,
    });
  }

  // Sort by expected payoff.
  candidates.sort((a, b) => b.expectedValue - a.expectedValue);

  return candidates;
}
