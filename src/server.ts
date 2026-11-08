import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolDeps } from "./tools.js";
import { MochiClient } from "./mochi/client.js";
import { MochiQueue, type QueueDeps } from "./mochi/queue.js";
import { JobManager } from "./jobs.js";
import { CardIndex } from "./mochi/card-index.js";
import type { Config } from "./config.js";

export const SERVER_NAME = "mochi-mcp";
export const SERVER_VERSION = process.env.APP_VERSION ?? "dev";

const INSTRUCTIONS = `Mochi Cards flashcards. Every Mochi API call passes through one rate-limited queue (Mochi allows one concurrent request per account).
- Prefer the batch tools (create_cards, update_cards, delete_cards, get_cards) over many single calls; they run as background jobs and return a job_id when they need longer than wait_seconds. Poll with get_job rather than resubmitting.
- list_decks and list_templates are cached; call them once and reuse the IDs.\n- To find cards by text (a kanji, word, grammar form, meaning), use search_cards — ideally limited to deck_ids — instead of paging through list_cards. Use queries to look up many terms at once. Its cache stays current for edits made through this server; pass refresh=true only if the user changed cards in the Mochi app.
- Card content is Markdown; separate sides with a line containing only ---.
- Prefer trashing (trashed=true, or delete_cards mode="trash") over permanent deletion.`;

/** Long-lived dependencies shared by every MCP session in the process. */
export function createDeps(config: Config, queueDeps: QueueDeps = {}, fetchImpl: typeof fetch = fetch): ToolDeps {
  const queue = new MochiQueue(config.queue, queueDeps);
  const client = new MochiClient(config.mochiApiKey, queue, config.mochiBaseUrl, fetchImpl);
  const jobs = new JobManager({ estimateItemMs: () => queue.getStats().currentIntervalMs + 400 });
  const index = new CardIndex(client, config.searchCacheTtlMs);
  return { client, jobs, index, fetchImpl };
}

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerTools(server, deps);
  return server;
}
