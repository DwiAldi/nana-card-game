import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

interface Card {
  id: string;
  number: number;
  isRevealed: boolean;
}

interface Player {
  id: string;
  name?: string;
  isMe?: boolean;
  isPlaying?: boolean;
  hand: Card[];
  collection: Card[];
}

type GameStage = string;
type GameSubStage = string | undefined;

interface GameState {
  gameStage: GameStage;
  gameSubStage: GameSubStage;
  cardDeck: Card[];
  publicCards: Card[];
  players: Player[];
  // myCards: string[];
  // botCards: string[];
}
interface GameStateActions {
  getPlayer: (playerId: string) => Player | undefined;
  updateCardDeck: (cardDeck: Card[]) => void;
  dealCard: (cardId: string, playerId: string) => void;
  updatePlayers: (players: Player[]) => void;
}

export const useClientGameStore = create<GameState & GameStateActions>()(
  immer((set, get) => ({
    gameStage: "seat",
    gameSubStage: undefined,
    cardDeck: [],
    publicCards: [],
    players: [],

    // functions
    updatePlayers: (players: Player[]) =>
      set({
        players: players.map((p) => ({
          ...p,
          hand: [],
          collection: [],
        })),
      }),
    updateCardDeck: (cardDeck: Card[]) =>
      set({
        cardDeck: cardDeck,
      }),
    // functions
    getPlayer: (playerId: string) => {
      return get().players.find((p) => p.id === playerId);
    },

    dealCard: (cardId: string, playerId: string) => {
      console.log(`deal card: ${cardId} to player: ${playerId}`);
      set((state) => {
        const poppedCard = popCard(state.cardDeck, cardId);
        let targetPlayer = state.players.find((p) => p.id === playerId);
        if (!targetPlayer) {
          targetPlayer = {
            id: playerId,
            hand: [],
            collection: [],
          };
          state.players.push(targetPlayer);
        }
        if (poppedCard) targetPlayer.hand.push(poppedCard);
        // state.players[0].hand.push(popCard);
      });
    },
  })),
);

const popCard = (cards: Card[], cardId: string) => {
  const cardIndex = cards.findIndex((c) => c.id === cardId);
  const [removedCard] = cards.splice(cardIndex, 1);
  return removedCard;
};
