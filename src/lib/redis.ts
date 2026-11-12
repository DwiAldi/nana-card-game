import { createClient, type RedisClientType } from "redis";

/**
 * Server Redis foundation.
 *
 * Everything in this module is lazy on purpose:
 *
 * - Importing it never opens a socket, so `next build` succeeds with Redis
 *   unreachable or unconfigured.
 * - The shared connection is established through exactly one promise, so
 *   concurrent requests never race to create competing clients.
 * - `WATCH` transactions need a connection of their own: a watched key is
 *   bound to a connection, so transactions use the isolated factory below
 *   and always release it again.
 *
 * No credential, URL or connection string is ever placed in a thrown message
 * or a log line. Failures surface as a generic `RedisUnavailableError` and
 * the underlying cause is logged redacted.
 */

export const REDIS_CONNECT_TIMEOUT_MS = 5_000;
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;
/** Reconnect attempts after the initial connection failed. */
export const REDIS_MAX_RECONNECT_ATTEMPTS = 5;
export const REDIS_RECONNECT_BASE_DELAY_MS = 50;
export const REDIS_RECONNECT_MAX_DELAY_MS = 2_000;

/** The Redis URL is missing: the deployment is not configured. */
export class RedisConfigurationError extends Error {
  constructor(
    message = "Redis is not configured: set the REDIS_URL environment variable",
  ) {
    super(message);
    this.name = "RedisConfigurationError";
  }
}

/** Redis is configured but could not be reached. */
export class RedisUnavailableError extends Error {
  constructor(message = "Redis is unavailable") {
    super(message);
    this.name = "RedisUnavailableError";
  }
}

/** Matches `redis://…`, `rediss://…` and any other `scheme://…` value. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
/** Matches `password=…`, `token=…` and similar credential fragments. */
const SECRET_PATTERN =
  /\b(password|passwd|pwd|secret|token|credential)s?\b\s*[=:]\s*[^\s,;"'&]+/gi;

/**
 * Removes connection strings and credential fragments from a message.
 *
 * Redis client errors can embed the URL they were built from, so every
 * message that leaves this module passes through here first.
 */
export function redactRedisText(text: string): string {
  return text
    .replace(URL_PATTERN, "[redacted]")
    .replace(SECRET_PATTERN, "$1=[redacted]");
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function attachErrorListener(client: RedisClientType): void {
  // node-redis emits connection errors on the client. Without a listener
  // they would become uncaught exceptions and take the process down.
  client.on("error", (error: unknown) => {
    console.error("[redis] client error:", redactRedisText(describeError(error)));
  });
}

interface RedisGlobals {
  baseClient?: RedisClientType | null;
  connectPromise?: Promise<RedisClientType> | null;
  terminalClients?: WeakSet<RedisClientType>;
  reconnectWaiters?: WeakMap<RedisClientType, Set<() => void>>;
}

/**
 * The client is cached on `globalThis` so a development hot reload does not
 * leak a socket per reload.
 */
const globalForRedis = globalThis as unknown as RedisGlobals;
globalForRedis.terminalClients ??= new WeakSet<RedisClientType>();
globalForRedis.reconnectWaiters ??= new WeakMap<RedisClientType, Set<() => void>>();

function markTerminal(client: RedisClientType): void {
  globalForRedis.terminalClients?.add(client);
  const waiters = globalForRedis.reconnectWaiters?.get(client);
  if (!waiters) return;
  for (const notify of waiters) notify();
  waiters.clear();
}

/**
 * Reads the configured Redis URL.
 *
 * @throws {RedisConfigurationError} when no URL is configured. The message
 * names the environment variable but never its value.
 */
function requireRedisUrl(): string {
  const url = process.env.REDIS_URL?.trim();
  if (!url) throw new RedisConfigurationError();
  return url;
}

/**
 * The shared client. Created on first use, never at import time.
 *
 * The reconnect policy is finite: after {@link REDIS_MAX_RECONNECT_ATTEMPTS}
 * attempts the client stops trying and fails the pending command instead of
 * reconnecting forever.
 */
function getBaseClient(): RedisClientType {
  if (globalForRedis.baseClient) return globalForRedis.baseClient;

  const client = createClient({
    url: requireRedisUrl(),
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries: number) => {
        if (retries >= REDIS_MAX_RECONNECT_ATTEMPTS) {
          markTerminal(client);
          return false;
        }
        return Math.min(
          REDIS_RECONNECT_BASE_DELAY_MS * 2 ** retries,
          REDIS_RECONNECT_MAX_DELAY_MS,
        );
      },
    },
    commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
  });
  attachErrorListener(client);
  globalForRedis.baseClient = client;
  return client;
}

/**
 * Returns the shared, connected Redis client.
 *
 * The connection is established lazily through a single shared promise, so
 * concurrent callers await the same attempt instead of opening competing
 * sockets.
 */
export async function getRedis(): Promise<RedisClientType> {
  let client = getBaseClient();
  if (client.isReady) return client;

  if (!client.isOpen || globalForRedis.terminalClients?.has(client)) {
    if (globalForRedis.baseClient === client) globalForRedis.baseClient = null;
    try {
      client.destroy();
    } catch {
      // A terminal client may already have released its socket.
    }
    client = getBaseClient();
  }

  if (!globalForRedis.connectPromise) {
    const waitForConnection = client.isOpen
      ? new Promise<void>((resolve, reject) => {
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onTerminal = () => {
            cleanup();
            reject(new Error("Redis reconnect attempts exhausted"));
          };
          const cleanup = () => {
            client.off("ready", onReady);
            globalForRedis.reconnectWaiters?.get(client)?.delete(onTerminal);
          };
          client.once("ready", onReady);
          let waiters = globalForRedis.reconnectWaiters?.get(client);
          if (!waiters) {
            waiters = new Set();
            globalForRedis.reconnectWaiters?.set(client, waiters);
          }
          waiters.add(onTerminal);
          if (globalForRedis.terminalClients?.has(client)) onTerminal();
        })
      : client.connect();
    const attempt = waitForConnection
      .then(() => client)
      .catch((error: unknown) => {
        console.error("[redis] connection failed:", redactRedisText(describeError(error)));
        if (globalForRedis.baseClient === client) {
          globalForRedis.baseClient = null;
        }
        try {
          client.destroy();
        } catch {
          // The connection never opened; nothing to clean up.
        }
        throw new RedisUnavailableError();
      })
      .finally(() => {
        if (globalForRedis.connectPromise === attempt) {
          globalForRedis.connectPromise = null;
        }
      });
    globalForRedis.connectPromise = attempt;
  }

  return globalForRedis.connectPromise;
}

/**
 * A connection of its own, used by `WATCH` transactions.
 *
 * A watched key belongs to the connection that watched it, so a transaction
 * must never share the pooled client with unrelated commands.
 */
export interface IsolatedRedisConnection {
  readonly client: RedisClientType;
  /**
   * Clears any pending watch and closes the connection.
   *
   * Safe to call more than once; it never throws.
   */
  release(): Promise<void>;
}

/**
 * Opens an isolated connection for a `WATCH` transaction.
 *
 * The caller owns the connection and must release it (usually in a
 * `finally` block) so the socket and its watch are always cleaned up.
 */
export async function createIsolatedConnection(): Promise<IsolatedRedisConnection> {
  const client = getBaseClient().duplicate();
  attachErrorListener(client);

  try {
    await client.connect();
  } catch (error: unknown) {
    console.error("[redis] connection failed:", redactRedisText(describeError(error)));
    try {
      client.destroy();
    } catch {
      // The connection never opened; nothing to clean up.
    }
    throw new RedisUnavailableError();
  }

  let released = false;
  return {
    client,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        if (client.isOpen) await client.unwatch();
      } catch {
        // The connection is going away anyway; the watch dies with it.
      }
      try {
        if (client.isOpen) await client.close();
      } catch {
        try {
          client.destroy();
        } catch {
          // Nothing else can be done for a broken socket.
        }
      }
    },
  };
}

/**
 * Closes the shared connection and forgets it.
 *
 * Used by tests and by graceful shutdown; the next call to {@link getRedis}
 * opens a fresh connection.
 */
export async function closeRedis(): Promise<void> {
  const client = globalForRedis.baseClient;
  globalForRedis.baseClient = null;
  globalForRedis.connectPromise = null;
  if (!client) return;
  try {
    if (client.isOpen) await client.close();
  } catch {
    try {
      client.destroy();
    } catch {
      // Nothing else can be done for a broken socket.
    }
  }
}
