import { getRedis } from "@/lib/redis";
import { createHealthHandler } from "@/lib/server/health";

const HEALTH_TIMEOUT_MS = 3_000;

export const GET = createHealthHandler(async () => {
  const redis = await getRedis();
  await redis.ping();
}, HEALTH_TIMEOUT_MS);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
