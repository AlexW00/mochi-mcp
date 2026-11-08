# Mochi MCP

An [MCP](https://modelcontextprotocol.io) server for [Mochi Cards](https://mochi.cards).
It handles Mochi's API limits for you and works as a remote connector in Claude and ChatGPT.

This is a fork of [shunkus/mochi-mcp-server](https://github.com/shunkus/mochi-mcp-server).
The fork replaces the Vercel/Next.js transport with a standalone Node server and adds:

- **A single request queue.** [Mochi's API](https://mochi.cards/docs/api/) allows one
  concurrent request per account and answers bursts with `429`. All MCP sessions and
  batch jobs share one queue that sends one request at a time with a minimum gap
  between requests. On `429` the gap doubles and the request is retried, honouring
  `Retry-After`; the gap then shrinks gradually as requests succeed. Interactive calls
  go ahead of queued batch work.
- **Batch tools that run as background jobs.** Mochi has no bulk endpoints.
  `create_cards`, `update_cards`, `delete_cards` and `get_cards` accept up to
  500 items (200 for `get_cards`) and run them through the queue. Each one waits up to
  `wait_seconds`, then returns either the results or a `job_id` to poll with `get_job`.
  If an identical write batch is resubmitted within 15 minutes, the server returns the
  existing job instead of writing the items again.
- **Search.** Mochi's API cannot search, so `search_cards` loads the requested decks once
  (100 cards per queued request), keeps them in memory for 10 minutes and filters locally by
  text, field, tag or template. You can look up many terms in one call. Edits made through this
  server update the index immediately. Cards changed in the Mochi app appear after the TTL,
  with `refresh: true`, or per hit with `verify: true`, which re-fetches each hit live.
- **Safe partial updates.** When only some template fields change, the server reads the live
  card first and merges, so other fields are never dropped.
- **Fewer requests.** Deck and template lists are cached for five minutes; changes
  made through this server refresh the cache. `list_cards` can follow pagination at
  100 cards per page.
- **Safe retries.** `429` is always retried, because Mochi did not process the request.
  Timeouts, network errors and `5xx` responses are retried only for idempotent calls
  (reads, updates and deletes), never for card or deck creation.
- **Streamable HTTP with OAuth 2.1**, which Claude.ai and ChatGPT connectors need, plus a
  static bearer token for clients that can send headers.

## Tools

| Area | Tools |
| --- | --- |
| Cards | `search_cards`, `list_cards`, `get_card`, `create_card`, `update_card`, `delete_card`, `add_attachment`, `delete_attachment`, `get_due_cards` |
| Batch jobs | `create_cards`, `update_cards`, `delete_cards` (moves to trash by default), `get_cards`, `get_job`, `list_jobs`, `cancel_job` |
| Decks | `list_decks`, `get_deck`, `create_deck`, `update_deck`, `delete_deck` |
| Templates | `list_templates`, `get_template`, `create_template` |
| Diagnostics | `queue_status` |

Each tool has MCP annotations (read-only, destructive, idempotent), so clients can ask
before destructive calls. `add_attachment` downloads only from public `https` URLs,
following at most three redirects, and accepts files up to 10 MiB.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOCHI_API_KEY` | required | API key from Mochi → Account settings → API |
| `MCP_PUBLIC_URL` | required (HTTP) | Public origin, e.g. `https://mochi.example.com`; the endpoint is `<origin>/mcp` |
| `MCP_AUTH_SECRET` | required (HTTP) | Owner secret of at least 32 characters, e.g. `openssl rand -hex 32` |
| `MCP_AUTH_DISABLED` | `false` | `true` disables auth; use it only on a trusted local network |
| `OAUTH_REDIRECT_ALLOWLIST` | Claude, ChatGPT and loopback hosts | Comma-separated redirect hosts that OAuth clients may register; `*` allows any host |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Access token lifetime |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh token lifetime (30 days) |
| `MOCHI_MIN_INTERVAL_MS` | `300` | Minimum gap between Mochi requests |
| `MOCHI_MAX_INTERVAL_MS` | `30000` | Maximum adaptive gap after `429` |
| `MOCHI_MAX_RETRIES` | `6` | Retries per request |
| `MOCHI_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout |
| `MOCHI_MAX_PENDING` | `500` | Maximum number of queued requests |
| `PORT` | `8000` | Listening port |
| `TRUST_PROXY_HOPS` | `1` | Reverse proxies in front of the server, used for client IPs in rate limiting |

Run **one replica** per Mochi account. Each process has its own queue, so a second
replica would break Mochi's one-request-at-a-time limit. Batch jobs live in memory:
they last 24 hours and are lost when the process restarts.

## Authentication

The server is its own single-user OAuth authorization server, with no database:

1. A client discovers it through `/.well-known/oauth-protected-resource/mcp` and
   `/.well-known/oauth-authorization-server`, then registers dynamically.
2. You are sent to an approval page and enter `MCP_AUTH_SECRET`. A password manager
   can fill it in: save it as a login for your server's URL with username `owner`.
3. The client receives a one-hour access token and a refresh token, both protected with PKCE.

Clients, authorization codes and tokens are HMAC-signed and contain everything needed
to check them, so they survive restarts. Rotating `MCP_AUTH_SECRET` revokes every token
and client registration. Failed approval attempts are rate-limited, and only allowlisted
redirect hosts can register. The page shows the redirect host before you approve.

Any client that can send headers can also use `Authorization: Bearer <MCP_AUTH_SECRET>`.

### Connecting clients

- **Claude.ai / Claude Desktop:** Settings → Connectors → Add custom connector, URL
  `https://<host>/mcp`. Leave the OAuth client fields empty.
- **ChatGPT:** Settings → Apps & Connectors → Advanced → enable developer mode, then
  create a connector with URL `https://<host>/mcp` and authentication *OAuth*.
- **Claude Code:**
  `claude mcp add --transport http mochi https://<host>/mcp --header "Authorization: Bearer $MOCHI_MCP_SECRET"`,
  or omit the header and complete OAuth with `/mcp`.
- **Local stdio:** `MOCHI_API_KEY=… node dist/src/stdio.js`, without HTTP or auth.

## Development

```sh
npm ci
npm test          # build + unit and end-to-end tests (fake Mochi API, full OAuth flow)
npm run typecheck
MOCHI_API_KEY=… MCP_PUBLIC_URL=http://localhost:8000 MCP_AUTH_DISABLED=true npm start
```

## Releases and dependency updates

Every push to `main` that changes more than docs or Dependabot config publishes a release.
A daily run catches merges made by GitHub's auto-merge, which don't trigger push workflows.
Each release:

1. runs typecheck and tests;
2. creates the next patch version from the latest `vX.Y.Z` tag (manual runs of
   **Release** can bump the minor or major version instead);
3. publishes `ghcr.io/alexw00/mochi-mcp:X.Y.Z` plus `X.Y`, `X` and `latest` for
   `linux/amd64` and `linux/arm64`, with provenance and an SBOM;
4. smoke-tests the published image, then creates the GitHub release. The release
   notes contain the `X.Y.Z@sha256:…` reference to pin in deployments.

Versions come from git tags; `package.json` keeps `0.0.0-development`.

Dependabot opens weekly PRs for npm, the Docker base image and GitHub Actions.
Minor and patch updates are queued for auto-merge. Branch protection on `main`
requires the CI checks to pass first:

- `workflows`: actionlint
- `test`: typecheck and tests
- `image`: Docker build, container smoke test, auth-required startup check

PRs that fail a check stay open. Major updates always need manual review.

## License

ISC. See [LICENSE](LICENSE).
