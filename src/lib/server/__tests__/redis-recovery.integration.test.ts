import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeRedis, getRedis } from "@/lib/redis";

const TEST_REDIS_URL = process.env.TEST_REDIS_URL?.trim() ?? "";
const describeWithRedis = TEST_REDIS_URL ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const containerName = `nana-redis-recovery-${process.pid}-${Date.now()}`;

async function pollUntil<T>(
  operation: () => Promise<T>,
  accepts: (value: T) => boolean,
  deadlineMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (accepts(value)) return value;
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError instanceof Error ? lastError : new Error("Condition was not met before deadline");
}

afterAll(async () => {
  await closeRedis();
  vi.unstubAllEnvs();
  await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
});

describeWithRedis("shared Redis recovery", () => {
  it("creates a fresh client after terminal reconnect exhaustion", async () => {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      "127.0.0.1::6379",
      "redis:8.10.3-alpine",
    ]);
    const { stdout } = await execFileAsync("docker", ["port", containerName, "6379/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    expect(port).toBeTruthy();
    vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${port}`);

    const initialClient = await pollUntil(
      async () => getRedis(),
      (client) => client.isReady,
    );
    await expect(initialClient.ping()).resolves.toBe("PONG");
    await execFileAsync("docker", ["stop", containerName]);

    await pollUntil(
      async () => initialClient.isReady,
      (isReady) => !isReady,
    );
    const exhaustedReconnect = getRedis();

    await expect(exhaustedReconnect).rejects.toThrow("Redis is unavailable");

    await execFileAsync("docker", ["start", containerName]);
    await pollUntil(
      async () => {
        try {
          return (await execFileAsync("docker", ["exec", containerName, "redis-cli", "ping"]))
            .stdout.trim();
        } catch {
          return "";
        }
      },
      (reply) => reply === "PONG",
    );
    const { stdout: restartedPortOutput } = await execFileAsync("docker", [
      "port",
      containerName,
      "6379/tcp",
    ]);
    const restartedPort = restartedPortOutput.trim().match(/:(\d+)$/)?.[1];
    expect(restartedPort).toBeTruthy();
    vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${restartedPort}`);

    await expect(
      pollUntil(async () => (await getRedis()).ping(), (reply) => reply === "PONG"),
    ).resolves.toBe("PONG");
  }, 30_000);
});
