import {
  allRevealedCards,
  challengeSuccess,
  concealAllCards,
  getCurrentAndNextPlayer,
  removeTargetCards,
} from "@/lib/game-helper";
import { getRedis } from "@/lib/redis";
import type { ServerState } from "@/types";

export async function getServerState(gameId: string): Promise<ServerState> {
  const redis = await getRedis();
  const data = await redis.get(`game:${gameId}`);
  if (!data) throw new Error(`No game found for gameId: ${gameId}`);
  return JSON.parse(data) as ServerState;
}

export async function replaceState(
  gameId: string,
  serverState: ServerState,
): Promise<void> {
  const redis = await getRedis();
  await redis.set(`game:${gameId}`, JSON.stringify(serverState));
}

export async function setGameOver(
  gameId: string,
  serverState: ServerState,
  winnerId: string,
): Promise<void> {
  Object.assign<ServerState, Partial<ServerState>>(serverState, {
    gameStage: "stage:game-over",
    gameSubStage: null,
    timestamp: Date.now(),
  });
  serverState.players.forEach((player) => {
    player.isPlaying = false;
    if (winnerId === player.id) player.isWinner = true;
  });

  await replaceState(gameId, serverState);
}

export async function settleAndNextRound(
  gameId: string,
  serverState: ServerState,
): Promise<void> {
  const revealedCards = allRevealedCards(serverState);
  const [currentPlayer, nextPlayer] = getCurrentAndNextPlayer(
    serverState.players,
  );
  if (challengeSuccess(revealedCards)) {
    removeTargetCards(serverState, revealedCards[0].number);
    currentPlayer.collection = [...currentPlayer.collection, ...revealedCards];
  }

  currentPlayer.isPlaying = false;
  nextPlayer.isPlaying = true;
  serverState.gameSubStage = "sub:playing";
  serverState.timestamp = Date.now();
  concealAllCards(serverState);

  await replaceState(gameId, serverState);
}
