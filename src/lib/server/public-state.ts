import type {
  Card,
  PublicCard,
  PublicGameState,
  PublicPlayer,
  ServerState,
} from "@/types";

/**
 * Public-state serialization.
 *
 * Converts the internal server state into the projection the browser is
 * allowed to see. This module is the only place server state crosses the
 * trust boundary, and it works by whitelisting: nothing is copied unless it
 * is explicitly mapped below, so session material, deck order and hidden
 * card values can never leak into a response.
 *
 * Rules:
 * - A card's number appears only when the card is revealed; hidden cards
 *   carry just their opaque id.
 * - The projection is viewer-scoped: the player whose id equals `viewerId`
 *   sees their own hand with real numbers, because a player may always look
 *   at their own cards. Every other player's hand stays concealed, so one
 *   player's view never reveals another player's hand.
 * - Collected cards are public knowledge and serialize as visible even
 *   after a conceal pass.
 * - Removed public cards keep a stable empty slot (`id: ""`) so table
 *   positions do not jump; the empty slot never carries a number.
 */

/**
 * Serializes a single card.
 *
 * `revealNumber` is set for the viewer's own hand only: the owner of a card
 * may always see its value, so their hidden cards are serialized as revealed
 * with their number. Any other card keeps the concealment rule and exposes
 * nothing but its opaque id.
 */
function toPublicCard(card: Card, revealNumber = false): PublicCard {
  if (card.id === "") {
    // Stable empty slot for a removed card; never carries a value.
    return { id: "", isRevealed: false };
  }
  if (card.isRevealed || revealNumber) {
    return { id: card.id, isRevealed: true, number: card.number };
  }
  return { id: card.id, isRevealed: false };
}

function toCollectedCard(card: Card): PublicCard {
  return { id: card.id, isRevealed: true, number: card.number };
}

function toPublicPlayer(
  player: ServerState["players"][number],
  viewerId: string,
): PublicPlayer {
  const isViewer = player.id === viewerId;
  return {
    id: player.id,
    name: player.name,
    seat: player.seat,
    isHost: player.isHost === true,
    isWinner: player.isWinner === true,
    isPlaying: player.isPlaying === true,
    hand: (player.hand ?? []).map((card) => toPublicCard(card, isViewer)),
    collection: (player.collection ?? []).map((card) => toCollectedCard(card)),
  };
}

export function toPublicState(
  state: ServerState,
  viewerId: string,
): PublicGameState {
  return {
    gameId: state.gameId,
    gameStage: state.gameStage,
    gameSubStage: state.gameSubStage ?? null,
    timestamp: state.timestamp,
    viewerId,
    players: state.players.map((player) => toPublicPlayer(player, viewerId)),
    publicCards: (state.publicCards ?? []).map((card) => toPublicCard(card)),
    messages: state.messages.map((message) => ({
      playerName: message.playerName,
      content: message.content,
      timestamp: message.timestamp,
    })),
  };
}
