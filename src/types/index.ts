export type GameStagePrefix = `stage:${string}`;
export type SubStagePrefix = `sub:${string}`;
export type ActionPrefix = `action:${string}`;

export interface ServerState {
  gameId: string;
  gameStage: GameStagePrefix;
  gameSubStage?: SubStagePrefix | null;
  timestamp: number;
  players: Player[];
  cardDeck?: Card[];
  publicCards?: Card[];
  messages: Message[];
}

export interface Player {
  id: string;
  name: string;
  seat: number;
  isHost?: boolean;
  isWinner?: boolean;
  isPlaying?: boolean;
  hand: Card[];
  collection: Card[];
}

export interface Card {
  id: string;
  number: number;
  isRevealed: boolean;
}

export interface Action {
  gameId: string;
  playerId: string;
  action: ActionPrefix;
  data: {
    playerId: string;
    playerName: string;
    cardId: string;
    targetPlayerId: string;
    minMax: "min" | "max";
    message: string;
  };
}

/**
 * Public card projection for networked play.
 *
 * Hidden cards expose only their opaque id; a card's number is present if
 * and only if the card is revealed. Opaque ids are unrelated to card values,
 * so a hidden card's value can never be derived from its id.
 *
 * The projection is viewer-scoped: inside the viewer's own hand, hidden
 * cards carry their number (the owner may always see their own cards),
 * while every other player's hidden cards stay numberless.
 */
export type PublicCard =
  | { id: string; isRevealed: false }
  | { id: string; isRevealed: true; number: number };

export interface PublicPlayer {
  id: string;
  name: string;
  seat: number;
  isHost: boolean;
  isWinner: boolean;
  isPlaying: boolean;
  /** The viewer's own hand carries numbers; other hands stay concealed. */
  hand: PublicCard[];
  collection: PublicCard[];
}

/**
 * The serialized game state sent to a browser. Contains no deck order, no
 * session material and no hidden card values of other players;
 * `viewerId` says whose view this projection belongs to.
 */
export interface PublicGameState {
  gameId: string;
  gameStage: GameStagePrefix;
  gameSubStage?: SubStagePrefix | null;
  timestamp: number;
  viewerId: string;
  players: PublicPlayer[];
  publicCards: PublicCard[];
  messages: Message[];
}

export interface LocalPlayerInfo {
  id: string;
  name: string;
}

export interface Message {
  playerName: string;
  timestamp: number;
  content: string;
}
