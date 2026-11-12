import { Card, Player, ServerState } from "@/types";
import { sum7Pairs } from "@/lib/rules";

/**
 * The two reveal choices a player can make.
 *
 * Defined here so this client-shared module never has to import the
 * server-only validation layer; the server re-exports the very same union
 * from its action parser.
 */
export type MinMax = "min" | "max";

export const allRevealedCards = (serverState: ServerState) => {
  const revealedCards: Card[] = [];
  serverState.players.forEach((p) =>
    p.hand?.forEach((c) => c.isRevealed && revealedCards.push(c)),
  );
  serverState.publicCards?.forEach(
    (c) => c.isRevealed && revealedCards.push(c),
  );
  return revealedCards;
};

export const isTurnOver = (serverState: ServerState): boolean => {
  const revealedCards = allRevealedCards(serverState);
  if (revealedCards.length === 2) {
    return revealedCards[0].number !== revealedCards[1].number;
  }
  return revealedCards.length >= 3;
};

export const findWinner = (serverState: ServerState): Player | undefined => {
  return serverState.players.find((p) => isPlayerWin(p));
};

export const isPlayerWin = (player: Player) => {
  if (!player.collection || player.collection.length === 0) {
    return false;
  }
  if (player.collection.length === 9) {
    return true;
  }
  if (player.collection.some((c) => c.number === 7)) {
    return true;
  }
  if (player.collection.length === 6) {
    const collectNumbers = player.collection.map((c) => c.number);
    return sum7Pairs.some((pair) =>
      pair.every((n) => collectNumbers.includes(n)),
    );
  }
};

export function challengeFailed(cards: Card[]): boolean {
  if (cards.length <= 1) return false;
  if (cards.length === 2) return cards[0].number !== cards[1].number;
  if (cards.length === 3)
    return (
      cards[0].number !== cards[1].number || cards[1].number !== cards[2].number
    );
  return true;
}

export function challengeSuccess(cards: Card[]): boolean {
  if (cards.length < 3) return false;
  return (
    cards[0].number === cards[1].number && cards[1].number === cards[2].number
  );
}

/**
 * Numeric comparators for card ordering.
 *
 * Hands must be ordered by card value so "min"/"max" means lowest/highest
 * number. Server deck cards carry unpredictable opaque ids, so ordering by
 * id would be arbitrary and could silently leak nothing but also select the
 * wrong card; these comparators sort by number first and use the id only as
 * a stable tiebreak between duplicate values.
 */
export const sortByNumberAsc = (a: Card, b: Card): number =>
  a.number - b.number ||
  a.id.localeCompare(b.id, undefined, { numeric: true });

export const sortByNumberDesc = (a: Card, b: Card): number => sortByNumberAsc(b, a);

export function findUnrevealedCardId(
  cards: Card[] | undefined,
  minMax: MinMax,
): string | undefined {
  if (!cards) return undefined;
  const unrevealed = cards.filter((c) => !c.isRevealed);
  if (unrevealed.length === 0) return undefined;
  const sorted = [...unrevealed].sort(
    minMax === "min" ? sortByNumberAsc : sortByNumberDesc,
  );
  return sorted[0]?.id;
}

export function getCurrentAndNextPlayer(players: Player[]): Player[] {
  const cpIndex = players.findIndex((player) => player.isPlaying);

  if (cpIndex === -1) {
    return [players[0], players[0]];
  }

  if (cpIndex === players.length - 1) {
    return [players[cpIndex], players[0]];
  }

  return [players[cpIndex], players[cpIndex + 1]];
}

export const concealAllCards = (serverState: ServerState) => {
  serverState.players.forEach((p) =>
    p.hand?.forEach((c) => {
      c.isRevealed = false;
    }),
  );
  serverState.publicCards?.forEach((c) => {
    c.isRevealed = false;
  });
};

export const removeTargetCards = (
  serverState: Pick<ServerState, "players" | "publicCards">,
  targetCardNumber: number,
) => {
  serverState.players.forEach(
    (p) => (p.hand = p.hand?.filter((c) => c.number !== targetCardNumber)),
  );
  // Mutate array in place to work correctly with Immer drafts
  if (serverState.publicCards) {
    for (let i = 0; i < serverState.publicCards.length; i++) {
      if (serverState.publicCards[i].number === targetCardNumber) {
        serverState.publicCards[i] = {
          id: "",
          number: targetCardNumber,
          isRevealed: false,
        };
      }
    }
  }
};

export const calculateDisplayPlayerIndices = (
  myPlayerId: string | undefined,
  players: Player[],
) => {
  const myIndex = players?.findIndex((p) => p.id === myPlayerId);
  if (myIndex < 0) {
    return [];
  }

  const originIndex = [];

  for (let i = 0; i < players.length; i++) {
    originIndex.push(i);
  }
  for (let i = 0; i < players.length; i++) {
    originIndex.push(i);
  }

  return originIndex.splice(myIndex, players.length);
};

export const sortByIdAsc = (a: Card, b: Card) =>
  a.id.localeCompare(b.id, undefined, {
    numeric: true,
  });

export const sortByIdDesc = (a: Card, b: Card) =>
  b.id.localeCompare(a.id, undefined, {
    numeric: true,
  });
