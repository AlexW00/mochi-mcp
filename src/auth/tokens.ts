import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export type TokenType = "access" | "refresh" | "code" | "request" | "client";

const PREFIX = "mm1";

/**
 * Compact HMAC-signed tokens: `mm1.<base64url payload>.<base64url signature>`.
 * Tokens are bound to a type so one kind can never be replayed as another.
 * Everything the OAuth server needs is inside the token, so the server keeps
 * no database and survives restarts; rotating MCP_AUTH_SECRET revokes all.
 */
export class TokenSigner {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync("sha256", secret, "mochi-mcp", "token-signing-v1", 32));
  }

  sign(type: TokenType, payload: Record<string, unknown>, ttlSeconds?: number): string {
    const now = Math.floor(Date.now() / 1000);
    const body = { ...payload, typ: type, iat: now, ...(ttlSeconds ? { exp: now + ttlSeconds } : {}) };
    const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
    return `${PREFIX}.${encoded}.${this.mac(encoded)}`;
  }

  verify<T extends Record<string, unknown>>(type: TokenType, token: string): (T & { iat: number; exp?: number }) | undefined {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) return undefined;
    const [, encoded = "", signature = ""] = parts;
    if (!safeEqual(signature, this.mac(encoded))) return undefined;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (body.typ !== type) return undefined;
    if (typeof body.exp === "number" && body.exp < Math.floor(Date.now() / 1000)) return undefined;
    return body as T & { iat: number; exp?: number };
  }

  /** Deterministic secret derived from a value (used for stateless client secrets). */
  derive(label: string, value: string): string {
    return createHmac("sha256", this.key).update(label).update("\0").update(value).digest("base64url");
  }

  private mac(data: string): string {
    return createHmac("sha256", this.key).update(data).digest("base64url");
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}
