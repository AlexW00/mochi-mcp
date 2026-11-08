import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthConfig } from "../config.js";
import { renderApprovalPage } from "./pages.js";
import { safeEqual, TokenSigner } from "./tokens.js";

export const SCOPE = "mochi";
const REQUEST_TTL_SECONDS = 10 * 60;
const CODE_TTL_SECONDS = 5 * 60;

interface ClientClaims extends Record<string, unknown> {
  r: string[];
  m: string;
  n?: string;
}

export interface PendingAuthorization extends Record<string, unknown> {
  c: string;
  ru: string;
  cc: string;
  st?: string;
  sc: string[];
}

interface CodeClaims extends PendingAuthorization {
  jti: string;
}

interface GrantClaims extends Record<string, unknown> {
  c: string;
  sc: string[];
}

/**
 * Single-owner OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Claude and ChatGPT connectors register dynamically (RFC 7591), then send the
 * owner through an approval page that requires MCP_AUTH_SECRET. Clients,
 * authorization codes and tokens are signed, self-contained values, so no
 * storage is needed. The same secret also works as a static bearer token for
 * clients that support custom headers (Claude Code, Codex, scripts).
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
  readonly signer: TokenSigner;
  private readonly usedCodes = new Map<string, number>();

  constructor(
    private readonly config: AuthConfig,
    readonly resource: URL,
  ) {
    this.signer = new TokenSigner(config.secret);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (metadata) => this.registerClient(metadata),
    };
  }

  isRedirectAllowed(uri: string): boolean {
    if (this.config.redirectAllowlist.includes("*")) return true;
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host);
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return false;
    return this.config.redirectAllowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  }

  private registerClient(
    metadata: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const disallowed = metadata.redirect_uris.filter((uri) => !this.isRedirectAllowed(uri));
    if (disallowed.length) {
      throw new InvalidClientMetadataError(`redirect_uri not allowed by this server: ${disallowed.join(", ")}`);
    }
    const method = metadata.token_endpoint_auth_method ?? "client_secret_basic";
    const clientName = typeof metadata.client_name === "string" ? metadata.client_name.slice(0, 100) : undefined;
    const clientId = this.signer.sign("client", { r: metadata.redirect_uris, m: method, n: clientName } satisfies ClientClaims);
    return this.clientInfo(clientId, { r: metadata.redirect_uris, m: method, n: clientName }, metadata);
  }

  private getClient(clientId: string): OAuthClientInformationFull | undefined {
    const claims = this.signer.verify<ClientClaims>("client", clientId);
    if (!claims || !Array.isArray(claims.r) || !claims.r.every((uri) => this.isRedirectAllowed(uri))) return undefined;
    return this.clientInfo(clientId, claims);
  }

  private clientInfo(
    clientId: string,
    claims: ClientClaims,
    metadata: Partial<OAuthClientInformationFull> = {},
  ): OAuthClientInformationFull {
    const confidential = claims.m !== "none";
    return {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: typeof claims.iat === "number" ? claims.iat : Math.floor(Date.now() / 1000),
      client_name: claims.n,
      redirect_uris: claims.r,
      token_endpoint_auth_method: claims.m,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(confidential
        ? { client_secret: this.signer.derive("client-secret", clientId), client_secret_expires_at: 0 }
        : { client_secret: undefined, client_secret_expires_at: undefined }),
    } as OAuthClientInformationFull;
  }

  private checkResource(resource: URL | undefined): void {
    if (!resource) return;
    // Accept the MCP endpoint itself or the bare origin; anything else targets another resource.
    const path = resource.pathname.replace(/\/$/, "");
    const expected = this.resource.pathname.replace(/\/$/, "");
    if (resource.origin !== this.resource.origin || (path !== "" && path !== expected)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resource.href}`);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const pending: PendingAuthorization = {
      c: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: params.scopes?.length ? params.scopes : [SCOPE],
    };
    const request = this.signer.sign("request", pending, REQUEST_TTL_SECONDS);
    sendApprovalPage(res, {
      request,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
    });
  }

  /** Validates the approval form and returns the redirect target. */
  approve(request: string, password: string, decision: string): { redirect: string } | { error: string; pending?: PendingAuthorization } {
    const pending = this.signer.verify<PendingAuthorization>("request", request);
    if (!pending) return { error: "This authorization request expired. Start the connection again from your client." };
    const target = new URL(pending.ru);
    if (pending.st) target.searchParams.set("state", pending.st);
    if (decision === "deny") {
      const error = new AccessDeniedError("The owner denied access");
      target.searchParams.set("error", error.errorCode);
      target.searchParams.set("error_description", error.message);
      return { redirect: target.href };
    }
    if (!safeEqual(password, this.config.secret)) return { error: "Incorrect secret.", pending };
    const code = this.signer.sign("code", { ...pending, jti: randomUUID() } satisfies CodeClaims, CODE_TTL_SECONDS);
    target.searchParams.set("code", code);
    return { redirect: target.href };
  }

  private readCode(client: OAuthClientInformationFull, code: string): CodeClaims {
    const claims = this.signer.verify<CodeClaims>("code", code);
    if (!claims || claims.c !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return claims;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.readCode(client, authorizationCode).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const claims = this.readCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== claims.ru) throw new InvalidGrantError("redirect_uri mismatch");
    this.checkResource(resource);
    this.pruneCodes();
    if (this.usedCodes.has(claims.jti)) throw new InvalidGrantError("Authorization code already used");
    this.usedCodes.set(claims.jti, Number(claims.exp ?? 0) * 1000);
    return this.issueTokens(client.client_id, claims.sc);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const claims = this.signer.verify<GrantClaims>("refresh", refreshToken);
    if (!claims || claims.c !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
    this.checkResource(resource);
    const granted = scopes?.length ? scopes.filter((scope) => claims.sc.includes(scope)) : claims.sc;
    return this.issueTokens(client.client_id, granted.length ? granted : claims.sc);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (safeEqual(token, this.config.secret)) {
      return {
        token: "static",
        clientId: "static-bearer",
        scopes: [SCOPE],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: this.resource,
      };
    }
    const claims = this.signer.verify<GrantClaims>("access", token);
    if (!claims || typeof claims.exp !== "number") throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: claims.c, scopes: claims.sc, expiresAt: claims.exp, resource: this.resource };
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const grant: GrantClaims = { c: clientId, sc: scopes };
    return {
      access_token: this.signer.sign("access", grant, this.config.accessTokenTtlSeconds),
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: this.signer.sign("refresh", grant, this.config.refreshTokenTtlSeconds),
      scope: scopes.join(" "),
    };
  }

  private pruneCodes(): void {
    const now = Date.now();
    for (const [jti, expiresAt] of this.usedCodes) if (expiresAt < now) this.usedCodes.delete(jti);
  }
}

export function sendApprovalPage(
  res: Response,
  options: { request: string; clientName?: string; redirectUri: string; error?: string },
  status = 200,
): void {
  const redirectOrigin = new URL(options.redirectUri).origin;
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    })
    .send(renderApprovalPage(options));
}
