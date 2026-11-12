import { getRedis } from "@/lib/redis";
import { shuffle } from "@/lib/random";
import {
  findUnrevealedCardId,
  getCurrentAndNextPlayer,
  isTurnOver,
  sortByIdAsc,
} from "@/lib/game-helper";
import { Action, Card, ServerState } from "@/types";
import { ALL_CARDS, GAME_RULES } from "@/lib/rules";
import { getServerState, replaceState } from "@/lib/server-game-state";

export async function POST(request: Request) {
  try {
    const redis = await getRedis();
    const action = (await request.json()) as Action;

    // TODO use state design pattern
    switch (action.action) {
      case "action:host": {
      }
    }
    if (action.action === "action:host") {
      const initialState: ServerState = {
        gameId: action.gameId,
        gameStage: "stage:lobby",
        timestamp: Date.now(),
        players: [
          {
            id: action.data.playerId,
            name: action.data.playerName,
            seat: 1,
            isHost: true,
            isPlaying: false,
            hand: [],
            collection: [],
            isWinner: false,
          },
        ],
        cardDeck: ALL_CARDS,
        publicCards: [],
        messages: [],
      };
      await redis.set(`game:${action.gameId}`, JSON.stringify(initialState), {
        EX: 60 * 60,
      });
    }

    const serverState = await getServerState(action.gameId);
    const [currentPlayer] = getCurrentAndNextPlayer(serverState.players);
    const playerNumber = serverState.players.length;

    if (action.action === "action:join") {
      if (playerNumber >= 6) {
        throw new Error("the room is full");
      }
      if (serverState.players.some((p) => p.id === action.playerId)) {
        // player is already in the room
        return Response.json(serverState);
      }
      serverState.players.push({
        id: action.playerId,
        name: action.data.playerName,
        seat: playerNumber + 1,
        isHost: false,
        isPlaying: false,
        hand: [],
        collection: [],
      });
    }

    if (action.action === "action:start-game") {
      if (serverState.gameStage === "stage:in-game") {
        throw new Error("game is already start");
      }
      if (playerNumber <= 1) {
        throw new Error("requires two or more players");
      }
      const gameRule = GAME_RULES[playerNumber];
      console.log(gameRule);

      const shuffled: Card[] = shuffle([...gameRule.cards]);

      Object.assign<ServerState, Partial<ServerState>>(serverState, {
        gameStage: "stage:in-game",
        gameSubStage: "sub:playing",
        cardDeck: [],
        players: serverState.players.map((p) => ({
          ...p,
          hand: shuffled.splice(0, gameRule.handNumber).sort(sortByIdAsc),
          collection: [],
          isPlaying: p.id === action.playerId,
          isWinner: false,
        })),
        publicCards: shuffled,
      });
    }

    if (action.action === "action:reveal-public-card") {
      if (serverState.gameStage === "stage:game-over") {
        throw new Error("game is already over");
      }
      if (currentPlayer.id !== action.playerId) {
        throw new Error("not your turn now");
      }
      if (serverState.gameSubStage === "sub:settling") {
        throw new Error("this round is over, please wait for the settlement");
      }
      Object.assign<ServerState, Partial<ServerState>>(serverState, {
        publicCards: serverState.publicCards?.map((c) => ({
          ...c,
          isRevealed: c.id === action.data.cardId ? true : c.isRevealed,
        })),
      });

      if (isTurnOver(serverState)) {
        Object.assign<ServerState, Partial<ServerState>>(serverState, {
          gameSubStage: "sub:settling",
          timestamp: Date.now(),
        });
        // does not work in vercel serverless function, maybe process shut down when return
        // settling and restore all cards
        // setTimeout(() => {
        //   settleAndNextRound(action, serverState);
        // }, 100);
      }
    }

    if (action.action === "action:reveal-player-card") {
      if (serverState.gameStage === "stage:game-over") {
        throw new Error("game is already over");
      }
      if (currentPlayer.id !== action.playerId) {
        throw new Error("not your turn now");
      }
      const targetPlayer = serverState.players.find(
        (p) => p.id === action.data.targetPlayerId,
      );
      const unrevealedCardId = findUnrevealedCardId(
        targetPlayer?.hand,
        action.data.minMax,
      );
      if (!unrevealedCardId) {
        throw new Error("no more card");
      }

      const unrevealedCard = targetPlayer?.hand.find(
        (c) => c.id === unrevealedCardId,
      );
      if (!unrevealedCard) throw new Error("no more card");
      unrevealedCard.isRevealed = true;

      if (isTurnOver(serverState)) {
        Object.assign<ServerState, Partial<ServerState>>(serverState, {
          gameSubStage: "sub:settling",
          timestamp: Date.now(),
        });
      }
    }

    if (action.action === "action:chat") {
      const me = serverState.players.find((p) => p.id === action.playerId);
      if (!me) throw new Error("player not found");
      serverState.messages.unshift({
        playerName: me.name,
        content: action.data.message,
        timestamp: Date.now(),
      });
    }

    await replaceState(action.gameId, serverState);

    return Response.json(serverState);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 400 });
  }
}

export const runtime = "nodejs";
export const fetchCache = "force-no-store";
