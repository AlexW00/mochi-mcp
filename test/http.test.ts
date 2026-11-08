import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadHttpConfig } from "../src/config.js";
import { createApp } from "../src/http.js";
import { createDeps } from "../src/server.js";
import { FakeMochi } from "./fake-mochi.js";

const SECRET = "test-secret-0123456789abcdef0123456789";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let server: Server;
let base: string;
let mochi: FakeMochi;

before(async () => {
  mochi = new FakeMochi();
  const deps = createDeps(
    {
      mochiApiKey: "key",
      mochiBaseUrl: "https://mochi.test/api",
      queue: { minIntervalMs: 0, maxIntervalMs: 20, maxRetries: 5, requestTimeoutMs: 5_000, maxPending: 1_000 },
      searchCacheTtlMs: 7 * 24 * 3_600_000,
    },
    { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) },
    mochi.fetch,
  );
  // The public URL must match the listening origin, so bind before building the app.
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on("request", createApp(loadHttpConfig({ MCP_PUBLIC_URL: base, MCP_AUTH_SECRET: SECRET }), deps));
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", base), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

test("unauthenticated MCP requests get a discoverable 401", async () => {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
  const header = response.headers.get("www-authenticate") ?? "";
  assert.match(header, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);

  const resourceMeta = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
  assert.equal(resourceMeta.resource, `${base}/mcp`);
  const asMeta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(asMeta.registration_endpoint, `${base}/register`);
  assert.deepEqual(asMeta.code_challenge_methods_supported, ["S256"]);
});

test("health endpoint is public", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
});

test("rejects registrations with unknown redirect hosts", async () => {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(response.status, 400);
});

for (const authMethod of ["none", "client_secret_post"] as const) {
  test(`full OAuth flow (${authMethod}) and MCP batch call`, async () => {
    const registration = (await (
      await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: [CLAUDE_REDIRECT],
          token_endpoint_auth_method: authMethod,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      })
    ).json()) as { client_id: string; client_secret?: string };
    assert.ok(registration.client_id);
    assert.equal(Boolean(registration.client_secret), authMethod !== "none");

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${base}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${base}/mcp`,
    }).toString();
    const page = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Claude/);
    const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(request);

    const wrong = await fetch(`${base}/oauth/approve`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ request, password: "wrong", decision: "approve" }),
    });
    assert.equal(wrong.status, 401);

    const approved = await fetch(`${base}/oauth/approve`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ request, password: SECRET, decision: "approve" }),
    });
    assert.equal(approved.status, 302);
    const location = new URL(approved.headers.get("location")!);
    assert.equal(location.origin + location.pathname, CLAUDE_REDIRECT);
    assert.equal(location.searchParams.get("state"), "xyz");
    const code = location.searchParams.get("code")!;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: registration.client_id,
      resource: `${base}/mcp`,
    });
    if (registration.client_secret) tokenBody.set("client_secret", registration.client_secret);
    const tokenResponse = await fetch(`${base}/token`, { method: "POST", body: tokenBody });
    assert.equal(tokenResponse.status, 200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };

    const replay = await fetch(`${base}/token`, { method: "POST", body: tokenBody });
    assert.equal(replay.status, 400, "authorization codes are single-use");

    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: registration.client_id,
    });
    if (registration.client_secret) refreshBody.set("client_secret", registration.client_secret);
    const refreshed = await fetch(`${base}/token`, { method: "POST", body: refreshBody });
    assert.equal(refreshed.status, 200);

    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "create_cards"));
    await client.close();
  });
}

test("wrong PKCE verifier is rejected", async () => {
  const registration = (await (
    await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:4567/callback"], token_endpoint_auth_method: "none" }),
    })
  ).json()) as { client_id: string };
  const challenge = createHash("sha256").update("right-verifier-right-verifier-right-verifier").digest("base64url");
  const authorizeUrl = `${base}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  const html = await (await fetch(authorizeUrl)).text();
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const approved = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ request, password: SECRET }),
  });
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const response = await fetch(`${base}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
      client_id: registration.client_id,
    }),
  });
  assert.equal(response.status, 400);
});

test("static bearer secret works and batch jobs respect Mochi's concurrency limit", async () => {
  const client = await mcpClient(SECRET);
  mochi.rateLimitNext = 2;
  const cards = Array.from({ length: 12 }, (_, index) => ({ content: `Q${index}\n---\nA${index}` }));
  const created = parse(
    await client.callTool({ name: "create_cards", arguments: { deck_id: "deck1", cards, tags: ["n5"], wait_seconds: 10 } }),
  );
  assert.equal(created.status, "succeeded");
  assert.equal(created.succeeded, 12);

  // Parallel single calls from the model are serialised by the shared queue.
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      client.callTool({ name: "create_card", arguments: { deck_id: "deck1", content: `Parallel ${index}` } }),
    ),
  );
  assert.equal(mochi.concurrencyViolations, 0);
  assert.equal(mochi.maxInFlight, 1);
  assert.equal(mochi.cards.size, 17);
  assert.deepEqual([...mochi.cards.values()][0]?.["manual-tags"], ["n5"]);

  const duplicate = parse(
    await client.callTool({ name: "create_cards", arguments: { deck_id: "deck1", cards, tags: ["n5"], wait_seconds: 10 } }),
  );
  assert.equal(duplicate.deduplicated, true);
  assert.equal(mochi.cards.size, 17, "identical batch was not re-sent");

  const ids = [...mochi.cards.keys()].slice(0, 3);
  const trashed = parse(await client.callTool({ name: "delete_cards", arguments: { card_ids: ids } }));
  assert.equal(trashed.status, "succeeded");
  assert.ok(mochi.cards.get(ids[0]!)?.["trashed?"], "default delete mode trashes");

  const decks = parse(await client.callTool({ name: "list_decks", arguments: {} }));
  await client.callTool({ name: "list_decks", arguments: {} });
  assert.equal((decks.decks as unknown[]).length, 1);
  assert.equal(mochi.requests.filter((request) => request === "GET /api/decks").length, 1, "deck list is cached");

  const status = parse(await client.callTool({ name: "queue_status", arguments: {} }));
  assert.ok((status.queue as { rateLimited: number }).rateLimited >= 2);
  await client.close();
});
