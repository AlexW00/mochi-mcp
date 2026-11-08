export interface QueueConfig {
  /** Minimum pause between the end of one Mochi request and the start of the next. */
  minIntervalMs: number;
  /** Upper bound for the adaptive pause after repeated 429 responses. */
  maxIntervalMs: number;
  /** Retries for 429 responses and, for idempotent requests, transient failures. */
  maxRetries: number;
  /** Per-request timeout. */
  requestTimeoutMs: number;
  /** Maximum number of requests waiting in the queue. */
  maxPending: number;
}

export interface AuthConfig {
  /** Owner secret: accepted as a static bearer token and on the OAuth approval page. */
  secret: string;
  /** Hostnames allowed as OAuth redirect targets; "*" allows any. */
  redirectAllowlist: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

export interface HttpConfig {
  port: number;
  publicUrl: URL;
  auth: AuthConfig | undefined;
  trustProxy: number;
}

export interface Config {
  mochiApiKey: string;
  mochiBaseUrl: string;
  queue: QueueConfig;
  /** How long loaded decks stay in the search index before reloading. */
  searchCacheTtlMs: number;
}

export const DEFAULT_REDIRECT_ALLOWLIST = [
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "chat.openai.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
];

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  const mochiApiKey = env.MOCHI_API_KEY?.trim();
  if (!mochiApiKey) throw new Error("MOCHI_API_KEY is required");
  return {
    mochiApiKey,
    mochiBaseUrl: (env.MOCHI_BASE_URL ?? "https://app.mochi.cards/api").replace(/\/+$/, ""),
    queue: {
      minIntervalMs: int(env, "MOCHI_MIN_INTERVAL_MS", 300, 0, 60_000),
      maxIntervalMs: int(env, "MOCHI_MAX_INTERVAL_MS", 30_000, 0, 600_000),
      maxRetries: int(env, "MOCHI_MAX_RETRIES", 6, 0, 20),
      requestTimeoutMs: int(env, "MOCHI_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
      maxPending: int(env, "MOCHI_MAX_PENDING", 500, 1, 100_000),
    },
    searchCacheTtlMs: int(env, "MOCHI_SEARCH_CACHE_TTL_HOURS", 168, 0, 24 * 365) * 3_600_000,
  };
}

export function loadHttpConfig(env: Env = process.env): HttpConfig {
  const rawUrl = env.MCP_PUBLIC_URL?.trim();
  if (!rawUrl) throw new Error("MCP_PUBLIC_URL is required (for example https://mochi.example.com)");
  const publicUrl = new URL(rawUrl);
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("MCP_PUBLIC_URL must be an origin without path, query or fragment");
  }
  const authDisabled = env.MCP_AUTH_DISABLED === "true";
  const secret = env.MCP_AUTH_SECRET?.trim();
  let auth: AuthConfig | undefined;
  if (authDisabled) {
    if (secret) throw new Error("Set either MCP_AUTH_SECRET or MCP_AUTH_DISABLED=true, not both");
    auth = undefined;
  } else {
    if (!secret || secret.length < 32) {
      throw new Error("MCP_AUTH_SECRET must contain at least 32 characters (or set MCP_AUTH_DISABLED=true for local use)");
    }
    if (publicUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(publicUrl.hostname)) {
      throw new Error("MCP_PUBLIC_URL must use https when authentication is enabled");
    }
    const allowlist = env.OAUTH_REDIRECT_ALLOWLIST?.trim();
    auth = {
      secret,
      redirectAllowlist: allowlist
        ? allowlist.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_REDIRECT_ALLOWLIST,
      accessTokenTtlSeconds: int(env, "OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3_600, 60, 86_400),
      refreshTokenTtlSeconds: int(env, "OAUTH_REFRESH_TOKEN_TTL_SECONDS", 30 * 86_400, 3_600, 365 * 86_400),
    };
  }
  return {
    port: int(env, "PORT", 8000, 1, 65_535),
    publicUrl,
    auth,
    trustProxy: int(env, "TRUST_PROXY_HOPS", 1, 0, 10),
  };
}
