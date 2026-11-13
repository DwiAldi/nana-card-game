import { randomBytes, randomInt } from "node:crypto";
import type { Card, ServerState } from "@/types";
import {
  allRevealedCards,
  findUnrevealedCardId,
  findWinner,
  getCurrentAndNextPlayer,
  isTurnOver,
  challengeSuccess,
  concealAllCards,
  removeTargetCards,
  sortByNumberAsc,
  type MinMax,
} from "@/lib/game-helper";
import { GAME_RULES } from "@/lib/rules";
import { ApiError, BadRequestError, ForbiddenError } from "./errors";

/**
 * Authorized game transitions.
 *
 * Pure, server-only game logic extracted from the route handlers. Every
 * function takes the authenticated acting player id and the current time as
 * explicit arguments, validates membership and turn rights before touching
 * state, and never mutates its input: callers receive a new state or an
 * `ApiError` the route layer maps to a safe response.
 *
 * The internal `Card` type keeps numeric values for game logic and bot
 * reasoning; the browser only ever receives the sanitized public projection
 * from `public-state.ts`, where hidden cards carry unpredictable opaque ids
 * without any value.
 */

export const SETTLE_DELAY_MS = 2000;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** A game-state conflict: the action does not apply to the current state. */
export class ConflictError extends ApiError {
  constructor(message = "Conflicting game state") {
    super(409, message);
    this.name = "ConflictError";
  }
}

export type GameAction =
  | { type: "join"; name: string }
  | { type: "start" }
  | { type: "reveal-public"; cardId: string }
  | {
      type: "reveal-player";
      targetPlayerId: string;
      minMax: MinMax;
      /** Internal retry precondition; never accepted from public input. */
      selectedCardId?: string;
    }
  | { type: "chat"; message: string };

/**
 * Injectable randomness so tests stay deterministic. The defaults use
 * cryptographically strong randomness for card ids and shuffling; ids are
 * opaque and never derived from a card's value.
 */
export interface GameEngineDeps {
  generateCardId: () => string;
  shuffle: <T>(items: T[]) => T[];
}

function cryptoShuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export const defaultGameEngineDeps: GameEngineDeps = {
  generateCardId: () => randomBytes(12).toString("hex"),
  shuffle: cryptoShuffle,
};

/**
 * Creates the initial lobby state. `cardDeck` stays empty: server decks are
 * built at start time with opaque ids, so no id-to-value mapping is ever
 * stored in a lobby that clients can poll.
 */
export function createGameState(
  gameId: string,
  hostPlayerId: string,
  hostName: string,
  now: number,
): ServerState {
  return {
    gameId,
    gameStage: "stage:lobby",
    gameSubStage: null,
    timestamp: now,
    players: [
      {
        id: hostPlayerId,
        name: hostName,
        seat: 1,
        isHost: true,
        isPlaying: false,
        isWinner: false,
        hand: [],
        collection: [],
      },
    ],
    cardDeck: [],
    publicCards: [],
    messages: [],
  };
}

/** Builds a shuffled deck with fresh opaque ids for the given rule set. */
function buildDeck(
  rule: { cards: Card[]; handNumber: number; publicNumber: number },
  deps: GameEngineDeps,
): Card[] {
  const cards: Card[] = rule.cards.map((ruleCard) => ({
    id: deps.generateCardId(),
    // rules.ts stores the number as a string cast to a number; derive the
    // real numeric value from the card id so ordering and win checks work.
    number: Number.parseInt(ruleCard.id.split("-")[0], 10),
    isRevealed: false,
  }));
  return deps.shuffle(cards);
}

/** Finds a member or throws: acting identity must be a room member. */
function requireMember(state: ServerState, playerId: string) {
  const member = state.players.find((player) => player.id === playerId);
  if (!member) {
    throw new ForbiddenError("You are not in this game");
  }
  return member;
}

/** Reveals require an active game, the playing substage and the turn. */
function requireRevealTurn(state: ServerState, playerId: string): void {
  if (state.gameStage !== "stage:in-game") {
    throw new ConflictError("The game is not active");
  }
  if (state.gameSubStage !== "sub:playing") {
    throw new ConflictError("This round is over, please wait for the settlement");
  }
  const [currentPlayer] = getCurrentAndNextPlayer(state.players);
  if (currentPlayer.id !== playerId) {
    throw new ForbiddenError("Not your turn");
  }
}

/**
 * Applies a validated action to a state. Returns a new state; the input is
 * never mutated. Throws `ApiError` subclasses for every denied transition so
 * the route layer can map them straight to a safe HTTP response.
 */
export function applyGameAction(
  state: ServerState,
  action: GameAction,
  playerId: string,
  now: number,
  deps: GameEngineDeps = defaultGameEngineDeps,
): ServerState {
  if (action.type === "join") {
    if (state.gameStage !== "stage:lobby") {
      throw new ConflictError("This game has already started");
    }
    if (state.players.some((player) => player.id === playerId)) {
      // Already a member: joining again is a no-op. Deliberate hardening
      // divergence from the legacy route, which rejected a full room before
      // this membership check, locking a member out of their own room.
      return structuredClone(state);
    }
    if (state.players.length >= MAX_PLAYERS) {
      throw new ConflictError("The room is full");
    }
    const next = structuredClone(state);
    next.players.push({
      id: playerId,
      name: action.name,
      seat: next.players.length + 1,
      isHost: false,
      isPlaying: false,
      isWinner: false,
      hand: [],
      collection: [],
    });
    return next;
  }

  // Cheap gates (membership) run against the input before the deep copy, so
  // rejected actions never pay for a clone.
  const member = requireMember(state, playerId);

  const next = structuredClone(state);

  switch (action.type) {
    case "start": {
      if (!member.isHost) {
        throw new ForbiddenError("Only the host can start the game");
      }
      if (next.gameStage !== "stage:lobby") {
        // Deliberate hardening divergence from the legacy route, which only
        // rejected an in-game start and so allowed a restart from game-over;
        // only a lobby may start here.
        throw new ConflictError("The game has already started");
      }
      const playerCount = next.players.length;
      if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
        throw new ConflictError("Requires two or more players");
      }
      const rule = GAME_RULES[playerCount];
      if (!rule) {
        throw new ConflictError("Unsupported player count");
      }
      const deck = buildDeck(rule, deps);
      const handNumber = rule.handNumber;
      next.players = next.players.map((player, index) => ({
        ...player,
        hand: deck
          .slice(index * handNumber, (index + 1) * handNumber)
          .sort(sortByNumberAsc),
        collection: [],
        isPlaying: player.id === playerId,
        isWinner: false,
      }));
      next.publicCards = deck.slice(playerCount * handNumber);
      next.cardDeck = [];
      next.gameStage = "stage:in-game";
      next.gameSubStage = "sub:playing";
      next.timestamp = now;
      return next;
    }

    case "reveal-public": {
      requireRevealTurn(next, playerId);
      const cardToReveal = (next.publicCards ?? []).find((c) => c.id === action.cardId);
      if (!cardToReveal) {
        // Unknown targets never silently advance the game.
        throw new BadRequestError("Unknown card");
      }
      if (cardToReveal.isRevealed) {
        // Deliberate hardening divergence from the legacy route, which
        // silently allowed re-revealing an already-revealed public card.
        throw new ConflictError("Card already revealed");
      }
      cardToReveal.isRevealed = true;
      if (isTurnOver(next)) {
        next.gameSubStage = "sub:settling";
        next.timestamp = now;
      }
      return next;
    }

    case "reveal-player": {
      requireRevealTurn(next, playerId);
      const target = next.players.find((p) => p.id === action.targetPlayerId);
      if (!target) {
        throw new BadRequestError("Unknown target player");
      }
      const cardId = findUnrevealedCardId(target.hand, action.minMax);
      if (action.selectedCardId !== undefined && cardId !== action.selectedCardId) {
        throw new ConflictError("The selected card changed, please try again");
      }
      const targetCard = cardId
        ? target.hand.find((c) => c.id === cardId)
        : undefined;
      if (!cardId || !targetCard) {
        throw new ConflictError("No more cards to reveal");
      }
      targetCard.isRevealed = true;
      if (isTurnOver(next)) {
        next.gameSubStage = "sub:settling";
        next.timestamp = now;
      }
      return next;
    }

    case "chat": {
      next.messages.unshift({
        playerName: member.name,
        content: action.message,
        timestamp: now,
      });
      return next;
    }
  }
}

/**
 * Settles an overdue round. Any authenticated member's poll may call this —
 * a deliberate hardening divergence from the legacy flow, where only the
 * current player's client could drive settlement — so a disconnected
 * current player cannot stall the room.
 *
 * Returns a new state. Settlement happens at most once: while the state is
 * not settling, or before the two-second reveal delay elapses, the state is
 * returned unchanged.
 */
export function settleIfOverdue(
  state: ServerState,
  playerId: string,
  now: number,
): ServerState {
  // Cheap gate (membership) runs against the input before the deep copy, so
  // a rejected poll never pays for a clone.
  requireMember(state, playerId);

  const next = structuredClone(state);

  if (next.gameStage !== "stage:in-game" || next.gameSubStage !== "sub:settling") {
    return next;
  }
  if (now - next.timestamp <= SETTLE_DELAY_MS) {
    return next;
  }

  // Settle exactly once: collect matching cards, detect a winner, conceal
  // the remaining cards and select the next player.
  const revealedCards = allRevealedCards(next);
  const [currentPlayer, nextPlayer] = getCurrentAndNextPlayer(next.players);

  if (challengeSuccess(revealedCards)) {
    removeTargetCards(next, revealedCards[0].number);
    currentPlayer.collection = [...currentPlayer.collection, ...revealedCards];
  }

  currentPlayer.isPlaying = false;
  nextPlayer.isPlaying = true;
  next.gameSubStage = "sub:playing";
  next.timestamp = now;
  concealAllCards(next);

  const winner = findWinner(next);
  if (winner) {
    next.gameStage = "stage:game-over";
    next.gameSubStage = null;
    next.players.forEach((player) => {
      player.isPlaying = false;
      if (player.id === winner.id) player.isWinner = true;
    });
  }

  return next;
}
