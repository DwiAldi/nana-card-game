import { createGameApi } from "@/lib/server/game-api";
import { RedisGameRepository } from "@/lib/server/game-repository";
import { createRateLimiter } from "@/lib/server/rate-limit";
import { loadServerConfig } from "@/lib/server/session";
import { RedisSessionStore } from "@/lib/server/session-redis";

const trustedProxyHops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "0", 10);
const api = createGameApi({
  config: loadServerConfig(process.env),
  repository: new RedisGameRepository(),
  sessions: new RedisSessionStore(),
  limiter: createRateLimiter(),
  trustedProxyHops: Number.isSafeInteger(trustedProxyHops) && trustedProxyHops > 0
    ? trustedProxyHops
    : 0,
});

export const POST = api.action;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";
