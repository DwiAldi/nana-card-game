const HEALTH_HEADERS = {
  "cache-control": "no-store",
} as const;

type PingRedis = () => Promise<unknown>;

export function createHealthHandler(pingRedis: PingRedis, timeoutMs: number) {
  return async function GET(): Promise<Response> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        pingRedis(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Redis health check timed out")),
            timeoutMs,
          );
        }),
      ]);
      return Response.json({ status: "ok" }, { headers: HEALTH_HEADERS });
    } catch {
      return Response.json(
        { status: "unavailable" },
        { status: 503, headers: HEALTH_HEADERS },
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
