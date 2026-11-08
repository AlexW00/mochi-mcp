#!/usr/bin/env node
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { pathToFileURL } from "node:url";
import { loadConfig, loadHttpConfig, type HttpConfig } from "./config.js";
import { OwnerOAuthProvider, SCOPE, sendApprovalPage } from "./auth/provider.js";
import { createDeps, createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import type { ToolDeps } from "./tools.js";
import { log } from "./log.js";

export const MCP_PATH = "/mcp";

export function createApp(httpConfig: HttpConfig, deps: ToolDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", httpConfig.trustProxy);

  const resource = new URL(MCP_PATH, httpConfig.publicUrl);

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", version: SERVER_VERSION });
  });

  app.get("/", (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mcp_endpoint: resource.href,
      auth: httpConfig.auth ? "oauth2 (dynamic client registration) or static bearer token" : "disabled",
    });
  });

  let authMiddleware: express.RequestHandler | undefined;
  if (httpConfig.auth) {
    const provider = new OwnerOAuthProvider(httpConfig.auth, resource);
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: httpConfig.publicUrl,
        resourceServerUrl: resource,
        scopesSupported: [SCOPE],
        resourceName: "Mochi MCP",
        clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0 },
      }),
    );
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
    // Some clients look for protected resource metadata at the root path.
    app.get("/.well-known/oauth-protected-resource", (_req, res) => res.redirect(307, resourceMetadataUrl));

    const approvalLimiter = rateLimit({
      windowMs: 15 * 60_000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      message: "Too many attempts. Try again later.",
    });
    app.post("/oauth/approve", approvalLimiter, express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const request = typeof body.request === "string" ? body.request : "";
      const password = typeof body.password === "string" ? body.password : "";
      const decision = typeof body.decision === "string" ? body.decision : "approve";
      const outcome = provider.approve(request, password, decision);
      if ("redirect" in outcome) {
        log("oauth approval", { decision });
        res.redirect(302, outcome.redirect);
        return;
      }
      log("oauth approval rejected", { reason: outcome.pending ? "bad secret" : "expired request" });
      if (!outcome.pending) {
        res.status(400).type("text/plain").send(outcome.error);
        return;
      }
      // Failed attempt: count it against the limiter by answering with an error status.
      sendApprovalPage(
        res,
        { request, redirectUri: outcome.pending.ru, error: outcome.error, clientName: undefined },
        401,
      );
    });

    authMiddleware = requireBearerAuth({ verifier: provider, resourceMetadataUrl, expectedResource: resource });
  }

  const mcpRouter = express.Router();
  mcpRouter.use(express.json({ limit: "15mb" }));
  if (authMiddleware) mcpRouter.use(authMiddleware);

  mcpRouter.post("/", async (req: Request, res: Response) => {
    // Stateless Streamable HTTP: a fresh MCP server per request, sharing the
    // process-wide Mochi queue and job manager.
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log("mcp request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  mcpRouter.all("/", (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  });

  app.use(MCP_PATH, mcpRouter);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log("http error", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const httpConfig = loadHttpConfig();
  const deps = createDeps(config, { log });
  const app = createApp(httpConfig, deps);
  const server = app.listen(httpConfig.port, () => {
    log("listening", {
      port: httpConfig.port,
      endpoint: new URL(MCP_PATH, httpConfig.publicUrl).href,
      auth: httpConfig.auth ? "oauth+bearer" : "disabled",
    });
  });
  const shutdown = (signal: string) => {
    log("shutting down", { signal, activeJobs: deps.jobs.activeCount() });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
