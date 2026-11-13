import { createGameApi } from "@/lib/server/game-api";
import { RedisGameRepository } from "@/lib/server/game-repository";
import { createRateLimiter } from "@/lib/server/rate-limit";
import { loadServerConfig } from "@/lib/server/session";
import { RedisSessionStore } from "@/lib/server/session-redis";

const api = createGameApi({
  config: loadServerConfig(process.env),
  repository: new RedisGameRepository(),
  sessions: new RedisSessionStore(),
  limiter: createRateLimiter(),
});

export const GET = api.gameState;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";
