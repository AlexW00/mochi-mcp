import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { downloadAttachment, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import type { JobManager } from "./jobs.js";
import type { Card, CardInput, DeckInput, FieldValue, MochiClient, Template } from "./mochi/client.js";
import { CardIndex, expandDecks } from "./mochi/card-index.js";
import { MochiApiError } from "./mochi/queue.js";

export interface ToolDeps {
  client: MochiClient;
  jobs: JobManager;
  index: CardIndex;
  fetchImpl?: typeof fetch;
}

const MAX_BATCH = 500;
const DEFAULT_WAIT_SECONDS = 20;
const MAX_WAIT_SECONDS = 45;

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const UPDATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const LOCAL: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function guarded<A>(handler: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return json(await handler(args));
    } catch (error) {
      return failure(error);
    }
  };
}

const id = (what: string) => z.string().min(1).describe(`${what} ID`);
const tags = z.array(z.string().min(1)).describe("Tags without the leading #. Replaces the card's existing manual tags.");
const fields = z
  .record(z.string(), z.string())
  .describe("Template field values keyed by field ID (see get_template). When set, content may be empty.");
const waitSecondsSchema = (fallback: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .default(fallback)
    .describe("Seconds to wait for completion before returning progress and a job_id to poll with get_job.");
const waitSeconds = waitSecondsSchema(DEFAULT_WAIT_SECONDS);
const trashed = z.boolean().describe("true moves to trash (soft delete); false restores from trash.");

const cardProps = {
  content: z.string().describe("Markdown content. Separate sides with a line containing only ---."),
  template_id: id("Template").nullable(),
  fields,
  tags,
  archived: z.boolean(),
  review_reverse: z.boolean().describe("Also review the card in reverse order."),
  pos: z.string().describe("Lexicographic position within the deck."),
};

type CardArgs = {
  content?: string;
  deck_id?: string;
  template_id?: string | null;
  fields?: Record<string, string>;
  tags?: string[];
  archived?: boolean;
  review_reverse?: boolean;
  pos?: string;
  trashed?: boolean;
};

function toFieldMap(values: Record<string, string> | undefined): Record<string, FieldValue> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { id: key, value }]));
}

export function toCardInput(args: CardArgs): CardInput {
  const input: CardInput = {};
  if (args.content !== undefined) input.content = args.content;
  if (args.deck_id !== undefined) input["deck-id"] = args.deck_id;
  if (args.template_id !== undefined) input["template-id"] = args.template_id;
  if (args.fields !== undefined) input.fields = toFieldMap(args.fields);
  if (args.tags !== undefined) input["manual-tags"] = args.tags.map((tag) => tag.replace(/^#/, ""));
  if (args.archived !== undefined) input["archived?"] = args.archived;
  if (args.review_reverse !== undefined) input["review-reverse?"] = args.review_reverse;
  if (args.pos !== undefined) input.pos = args.pos;
  if (args.trashed !== undefined) input["trashed?"] = args.trashed ? new Date().toJSON() : null;
  return input;
}

function summarizeCard(card: Card) {
  return {
    id: card.id,
    deck_id: card["deck-id"],
    content_preview: typeof card.content === "string" ? card.content.slice(0, 80) : undefined,
  };
}

type DeckArgs = {
  name?: string;
  parent_id?: string | null;
  sort?: number;
  archived?: boolean;
  trashed?: boolean;
  sort_by?: string;
  cards_view?: string;
  show_sides?: boolean;
  sort_by_direction?: boolean;
  review_reverse?: boolean;
};

function toDeckInput(args: DeckArgs): DeckInput {
  const input: DeckInput = {};
  if (args.name !== undefined) input.name = args.name;
  if (args.parent_id !== undefined) input["parent-id"] = args.parent_id;
  if (args.sort !== undefined) input.sort = args.sort;
  if (args.archived !== undefined) input["archived?"] = args.archived;
  if (args.trashed !== undefined) input["trashed?"] = args.trashed ? new Date().toJSON() : null;
  if (args.sort_by !== undefined) input["sort-by"] = args.sort_by;
  if (args.cards_view !== undefined) input["cards-view"] = args.cards_view;
  if (args.show_sides !== undefined) input["show-sides?"] = args.show_sides;
  if (args.sort_by_direction !== undefined) input["sort-by-direction"] = args.sort_by_direction;
  if (args.review_reverse !== undefined) input["review-reverse?"] = args.review_reverse;
  return input;
}

const deckProps = {
  parent_id: id("Parent deck").nullable(),
  sort: z.number().describe("Sort position among sibling decks."),
  archived: z.boolean().describe("Archived decks show no new or due cards."),
  sort_by: z.enum([
    "none",
    "lexicographically",
    "created-at",
    "updated-at",
    "retention-rate-asc",
    "interval-length",
  ]),
  cards_view: z.enum(["list", "grid", "note", "column"]),
  show_sides: z.boolean(),
  sort_by_direction: z.boolean().describe("Reverse the card sort order."),
  review_reverse: z.boolean(),
};

function toTimestamp(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : date);
  if (Number.isNaN(parsed.getTime())) throw new Error("date must be YYYY-MM-DD or an ISO 8601 timestamp");
  return parsed.toJSON();
}

function compactDeck(deck: Record<string, unknown>) {
  return {
    id: deck.id,
    name: deck.name,
    parent_id: deck["parent-id"] ?? undefined,
    archived: deck["archived?"] || undefined,
    trashed: deck["trashed?"] ?? undefined,
  };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { client, jobs, index } = deps;

  /**
   * Partial field updates: read the live card first and merge, so changing one
   * template field never drops the others (and never uses stale cached data).
   */
  async function updateCardMerged(cardId: string, input: CardInput, priority: "interactive" | "bulk" = "interactive") {
    if (!input.fields) return client.updateCard(cardId, input, { priority });
    const current = await client.getCard(cardId, { priority });
    return client.updateCard(cardId, { ...input, fields: { ...(current.fields ?? {}), ...input.fields } }, { priority });
  }

  async function jobResult(jobId: string, wait: number, extra: Record<string, unknown> = {}) {
    await jobs.wait(jobId, wait * 1000);
    const snapshot = jobs.get(jobId, true);
    if (!snapshot) throw new Error(`Unknown job ${jobId}`);
    const finished = snapshot.remaining === 0 && snapshot.status !== "running" && snapshot.status !== "queued";
    return {
      ...extra,
      ...snapshot,
      results: finished ? snapshot.results : undefined,
      next_step: finished ? undefined : `Still running. Call get_job with job_id "${jobId}" to check progress.`,
    };
  }

  // Queue and jobs

  server.registerTool(
    "queue_status",
    {
      title: "Mochi queue status",
      description:
        "Shows the shared Mochi request queue: pending interactive/bulk requests, adaptive delay, retries and 429 counts, plus active batch jobs.",
      annotations: LOCAL,
    },
    guarded(async () => ({ queue: client.queue.getStats(), active_jobs: jobs.activeCount() })),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get batch job",
      description: "Returns progress and per-item results for a batch job started by a *_cards batch tool.",
      inputSchema: {
        job_id: z.string().min(1),
        wait_seconds: waitSecondsSchema(0),
        include_results: z.boolean().default(true),
      },
      annotations: LOCAL,
    },
    guarded(async ({ job_id, wait_seconds, include_results }) => {
      await jobs.wait(job_id, wait_seconds * 1000);
      const snapshot = jobs.get(job_id, include_results);
      if (!snapshot) throw new Error(`Unknown job ${job_id} (jobs are kept for 24 hours and lost on restart)`);
      return snapshot;
    }),
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List batch jobs",
      description: "Lists recent batch jobs (kept for 24 hours in memory) without per-item results.",
      annotations: LOCAL,
    },
    guarded(async () => ({ jobs: jobs.list() })),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel batch job",
      description: "Stops a running batch job before its next item. Items already sent to Mochi are not undone.",
      inputSchema: { job_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guarded(async ({ job_id }) => {
      const snapshot = jobs.cancel(job_id);
      if (!snapshot) throw new Error(`Unknown job ${job_id}`);
      return snapshot;
    }),
  );

  // Decks

  server.registerTool(
    "list_decks",
    {
      title: "List decks",
      description:
        "Lists all decks (all pages, cached for 5 minutes and refreshed after deck changes). Use refresh=true to bypass the cache.",
      inputSchema: {
        include_archived: z.boolean().default(true),
        include_trashed: z.boolean().default(false),
        refresh: z.boolean().default(false),
      },
      annotations: READ,
    },
    guarded(async ({ include_archived, include_trashed, refresh }) => {
      const decks = await client.listDecks({ refresh });
      return {
        decks: decks
          .filter((deck) => include_trashed || !deck["trashed?"])
          .filter((deck) => include_archived || !deck["archived?"])
          .map(compactDeck),
      };
    }),
  );

  server.registerTool(
    "get_deck",
    { title: "Get deck", description: "Returns all attributes of one deck.", inputSchema: { deck_id: id("Deck") }, annotations: READ },
    guarded(async ({ deck_id }) => client.getDeck(deck_id)),
  );

  server.registerTool(
    "create_deck",
    {
      title: "Create deck",
      description: "Creates a deck, optionally nested under parent_id.",
      inputSchema: { name: z.string().min(1), ...partial(deckProps) },
      annotations: WRITE,
    },
    guarded(async (args) => client.createDeck(toDeckInput(args))),
  );

  server.registerTool(
    "update_deck",
    {
      title: "Update deck",
      description: "Updates deck attributes. trashed=true soft-deletes the deck and its contents; false restores it.",
      inputSchema: { deck_id: id("Deck"), name: z.string().min(1).optional(), trashed: trashed.optional(), ...partial(deckProps) },
      annotations: UPDATE,
    },
    guarded(async ({ deck_id, ...args }) => client.updateDeck(deck_id, toDeckInput(args))),
  );

  server.registerTool(
    "delete_deck",
    {
      title: "Delete deck permanently",
      description:
        "Permanently deletes a deck. Cannot be undone; prefer update_deck with trashed=true. Cards and child decks are not deleted by Mochi.",
      inputSchema: { deck_id: id("Deck") },
      annotations: DESTRUCTIVE,
    },
    guarded(async ({ deck_id }) => {
      await client.deleteDeck(deck_id);
      return { deleted: deck_id };
    }),
  );

  // Templates

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description: "Lists all templates with their field IDs (all pages, cached for 5 minutes).",
      inputSchema: { refresh: z.boolean().default(false) },
      annotations: READ,
    },
    guarded(async ({ refresh }) => {
      const templates = await client.listTemplates({ refresh });
      return {
        templates: templates.map((template) => ({
          id: template.id,
          name: template.name,
          fields: Object.values(template.fields ?? {}).map((field) => ({ id: field.id, name: field.name, type: field.type })),
        })),
      };
    }),
  );

  server.registerTool(
    "get_template",
    {
      title: "Get template",
      description: "Returns a template's content and field definitions (cached for 5 minutes).",
      inputSchema: { template_id: id("Template"), refresh: z.boolean().default(false) },
      annotations: READ,
    },
    guarded(async ({ template_id, refresh }) => client.getTemplate(template_id, { refresh })),
  );

  server.registerTool(
    "create_template",
    {
      title: "Create template",
      description:
        "Creates a template. Reference fields in content as << Field name >>. Inspect an existing template with get_template first.",
      inputSchema: {
        name: z.string().min(1),
        content: z.string().min(1),
        pos: z.string().optional(),
        fields: z
          .array(
            z.object({
              id: z.string().min(1),
              name: z.string().min(1),
              type: z.string().default("text").describe("Field type, for example text, boolean, number, draw or ai."),
              pos: z.string().optional(),
              options: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .min(1),
      },
      annotations: WRITE,
    },
    guarded(async ({ name, content, pos, fields: fieldList }) =>
      client.createTemplate({
        name,
        content,
        pos,
        fields: Object.fromEntries(fieldList.map((field) => [field.id, field])),
      }),
    ),
  );

  // Cards: single operations

  server.registerTool(
    "search_cards",
    {
      title: "Search cards",
      description:
        "Searches cards by text in their fields (e.g. the kanji, word or grammar form), optionally limited to decks, fields, tags or a template. " +
        "Mochi's API has no search, so the server loads the requested decks once (100 cards per queued request), keeps them in memory for a week and filters locally; " +
        "later searches are instant. Edits made through this server (create/update/move/delete) update the cache immediately, but edits made in the Mochi app are not detected: " +
        "use refresh=true if the user says they changed cards there. Pass several terms in `queries` to look up many cards in one call. " +
        "Use the returned IDs with update_cards (e.g. deck_id to move cards), get_cards or delete_cards.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Single search term."),
        queries: z.array(z.string().min(1)).max(200).optional().describe("Several search terms; results are grouped per term."),
        deck_ids: z.array(id("Deck")).optional().describe("Limit to these decks. Strongly recommended for large collections."),
        include_subdecks: z.boolean().default(true),
        fields: z
          .array(z.string().min(1))
          .optional()
          .describe("Field IDs or names to search (e.g. [\"name\"] for the primary field, [\"meaning\"]). Default: all fields and content."),
        match: z.enum(["contains", "exact", "prefix", "regex"]).default("contains").describe("Matching ignores case, width, whitespace and 〜/～."),
        tags: z.array(z.string().min(1)).optional().describe("Only cards having all of these tags."),
        template_id: id("Template").optional(),
        include_archived: z.boolean().default(true),
        include_trashed: z.boolean().default(false),
        include_fields: z.boolean().default(false).describe("Return all field values of each hit (field name → value)."),
        limit: z.number().int().min(1).max(500).default(25).describe("Maximum hits per query."),
        refresh: z
          .boolean()
          .default(false)
          .describe("Reload the decks from Mochi first. Only needed after cards were added or edited outside this server (e.g. in the Mochi app); otherwise the cache is current."),
        verify: z
          .boolean()
          .default(false)
          .describe("Re-fetch every hit live before returning (drops cards deleted or changed elsewhere). One request per hit."),
        wait_seconds: waitSecondsSchema(30),
      },
      annotations: READ,
    },
    guarded(async (args) => {
      const queries = [...(args.query ? [args.query] : []), ...(args.queries ?? [])];
      if (!queries.length) throw new Error("Provide query or queries");
      if (args.match === "regex") for (const query of queries) new RegExp(query, "iu");
      const decks = await client.listDecks();
      const scope = args.deck_ids?.length ? expandDecks(args.deck_ids, decks, args.include_subdecks) : undefined;
      const loading = index.ensure(scope, args.refresh);
      let failed: unknown;
      loading.catch((error: unknown) => (failed = error));
      let timer: NodeJS.Timeout | undefined;
      const complete = await Promise.race([
        loading.then(() => true, () => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), args.wait_seconds * 1000))),
      ]);
      clearTimeout(timer);
      if (failed) throw failed;
      const templates = new Map<string, Template>((await client.listTemplates()).map((template) => [template.id, template]));
      const searchOptions = {
          queries,
          deckIds: scope,
          includeSubdecks: false,
          fields: args.fields,
          match: args.match,
          tags: args.tags,
          templateId: args.template_id,
          includeArchived: args.include_archived,
          includeTrashed: args.include_trashed,
          limitPerQuery: args.limit,
      };
      let results = index.search(searchOptions, decks, templates);
      if (args.verify) {
        const ids = [...new Set(results.flatMap((result) => result.hits.map((hit) => hit.id)))];
        for (const cardId of ids) {
          try {
            index.upsert(await client.getCard(cardId));
          } catch (error) {
            if (error instanceof MochiApiError && error.status === 404) index.remove(cardId);
            else throw error;
          }
        }
        results = index.search(searchOptions, decks, templates);
      }
      if (args.include_fields) {
        for (const result of results) {
          for (const hit of result.hits) {
            const card = index.get(hit.id);
            const template = card?.["template-id"] ? templates.get(card["template-id"]) : undefined;
            hit.fields = Object.fromEntries(
              Object.entries(card?.fields ?? {}).map(([fieldId, field]) => [template?.fields?.[fieldId]?.name ?? fieldId, field.value]),
            );
          }
        }
      }
      return {
        complete,
        indexed_cards: index.size(),
        index_age_seconds: index.ageSeconds(scope),
        verified: args.verify || undefined,
        results: queries.length === 1 ? undefined : results,
        ...(queries.length === 1 ? { total: results[0]?.total ?? 0, hits: results[0]?.hits ?? [] } : {}),
        next_step: complete
          ? undefined
          : "Still loading cards from Mochi; results so far are partial. Call search_cards again with the same arguments.",
      };
    }),
  );

  server.registerTool(
    "list_cards",
    {
      title: "List cards",
      description:
        "Lists cards, optionally for one deck. Returns one page (up to 100) with a bookmark, or with fetch_all=true follows bookmarks up to max_cards. Each page is one queued Mochi request.",
      inputSchema: {
        deck_id: id("Deck").optional(),
        limit: z.number().int().min(1).max(100).default(50),
        bookmark: z.string().optional(),
        fetch_all: z.boolean().default(false),
        max_cards: z.number().int().min(1).max(5000).default(1000),
      },
      annotations: READ,
    },
    guarded(async ({ deck_id, limit, bookmark, fetch_all, max_cards }) => {
      if (fetch_all) {
        const result = await client.listAllCards({ deckId: deck_id, maxCards: max_cards });
        return { count: result.docs.length, truncated: result.truncated, docs: result.docs };
      }
      return client.listCards({ deckId: deck_id, limit, bookmark });
    }),
  );

  server.registerTool(
    "get_card",
    { title: "Get card", description: "Returns one card.", inputSchema: { card_id: id("Card") }, annotations: READ },
    guarded(async ({ card_id }) => client.getCard(card_id)),
  );

  server.registerTool(
    "create_card",
    {
      title: "Create card",
      description: "Creates one card. For several cards use create_cards, which batches them through the rate-limited queue.",
      inputSchema: { deck_id: id("Deck"), ...partial(cardProps) },
      annotations: WRITE,
    },
    guarded(async (args) => {
      if (!args.content && !args.fields) throw new Error("Provide content or fields");
      return client.createCard(toCardInput({ ...args, content: args.content ?? "" }));
    }),
  );

  server.registerTool(
    "update_card",
    {
      title: "Update card",
      description:
        "Updates one card. Only provided attributes change; tags replace existing manual tags. trashed=true soft-deletes. For several cards use update_cards.",
      inputSchema: { card_id: id("Card"), deck_id: id("Target deck").optional(), trashed: trashed.optional(), ...partial(cardProps) },
      annotations: UPDATE,
    },
    guarded(async ({ card_id, ...args }) => updateCardMerged(card_id, toCardInput(args))),
  );

  server.registerTool(
    "delete_card",
    {
      title: "Delete card permanently",
      description: "Permanently deletes a card and its attachments. Prefer update_card with trashed=true for a reversible delete.",
      inputSchema: { card_id: id("Card") },
      annotations: DESTRUCTIVE,
    },
    guarded(async ({ card_id }) => {
      await client.deleteCard(card_id);
      return { deleted: card_id };
    }),
  );

  server.registerTool(
    "add_attachment",
    {
      title: "Add attachment",
      description:
        "Attaches a file (max 10 MiB) to a card from a public https URL or base64 data. Reference it in card content as ![](@media/<filename>).",
      inputSchema: {
        card_id: id("Card"),
        filename: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,128}$/, "Use letters, digits, dot, dash or underscore")
          .describe("File name including extension, e.g. audio1.mp3"),
        url: z.string().url().optional(),
        data_base64: z.string().optional(),
        content_type: z.string().optional().describe("MIME type; defaults to the download's type."),
      },
      annotations: WRITE,
    },
    guarded(async ({ card_id, filename, url, data_base64, content_type }) => {
      if (!url === !data_base64) throw new Error("Provide exactly one of url or data_base64");
      let data: Uint8Array;
      let type = content_type;
      if (url) {
        const downloaded = await downloadAttachment(url, deps.fetchImpl);
        data = downloaded.data;
        type ??= downloaded.contentType;
      } else {
        data = Buffer.from(data_base64 ?? "", "base64");
        if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 10 MiB");
      }
      await client.addAttachment(card_id, filename, data, type ?? "application/octet-stream");
      return { card_id, filename, bytes: data.byteLength, markdown: `![](@media/${filename})` };
    }),
  );

  server.registerTool(
    "delete_attachment",
    {
      title: "Delete attachment",
      description: "Deletes an attachment from a card.",
      inputSchema: { card_id: id("Card"), filename: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    guarded(async ({ card_id, filename }) => {
      await client.deleteAttachment(card_id, filename);
      return { card_id, deleted: filename };
    }),
  );

  server.registerTool(
    "get_due_cards",
    {
      title: "Get due cards",
      description: "Lists cards due on a date (default today), optionally for one deck.",
      inputSchema: {
        deck_id: id("Deck").optional(),
        date: z.string().optional().describe("YYYY-MM-DD or ISO 8601 timestamp"),
      },
      annotations: READ,
    },
    guarded(async ({ deck_id, date }) => client.getDueCards({ deckId: deck_id, date: toTimestamp(date) })),
  );

  // Cards: batch operations (background jobs on the shared queue)

  const batchCard = z.object({ deck_id: id("Deck").optional(), ...partial(cardProps) });

  server.registerTool(
    "create_cards",
    {
      title: "Create cards (batch)",
      description:
        `Creates up to ${MAX_BATCH} cards as a background job paced to Mochi's rate limits. ` +
        "Waits up to wait_seconds, then returns results or a job_id for get_job. " +
        "Resubmitting an identical batch within 15 minutes returns the existing job instead of creating duplicates (set allow_duplicate=true to override).",
      inputSchema: {
        cards: z.array(batchCard).min(1).max(MAX_BATCH),
        deck_id: id("Default deck").optional().describe("Deck for cards without their own deck_id."),
        template_id: id("Default template").optional(),
        tags: z.array(z.string().min(1)).optional().describe("Tags added to every card in the batch."),
        stop_on_error: z.boolean().default(false),
        allow_duplicate: z.boolean().default(false),
        wait_seconds: waitSeconds,
      },
      annotations: WRITE,
    },
    guarded(async ({ cards, deck_id, template_id, tags: sharedTags, stop_on_error, allow_duplicate, wait_seconds }) => {
      const inputs = cards.map((card, index) => {
        const deck = card.deck_id ?? deck_id;
        if (!deck) throw new Error(`cards[${index}] has no deck_id and no default deck_id was given`);
        if (!card.content && !card.fields) throw new Error(`cards[${index}] needs content or fields`);
        const mergedTags = sharedTags || card.tags ? [...new Set([...(card.tags ?? []), ...(sharedTags ?? [])])] : undefined;
        return toCardInput({
          ...card,
          content: card.content ?? "",
          deck_id: deck,
          template_id: card.template_id !== undefined ? card.template_id : template_id,
          tags: mergedTags,
        });
      });
      const { job, deduplicated } = jobs.submit(
        "create_cards",
        inputs,
        async (input) => summarizeCard(await client.createCard(input, { priority: "bulk" })),
        { stopOnError: stop_on_error, dedupeKey: allow_duplicate ? undefined : inputs },
      );
      return jobResult(job.job_id, wait_seconds, deduplicated ? { deduplicated: true } : {});
    }),
  );

  server.registerTool(
    "update_cards",
    {
      title: "Update cards (batch)",
      description:
        `Updates up to ${MAX_BATCH} cards as a background job (move decks, retag, archive, trash, edit content). ` +
        "Only provided attributes change per card. Returns results or a job_id for get_job.",
      inputSchema: {
        updates: z
          .array(z.object({ card_id: id("Card"), deck_id: id("Target deck").optional(), trashed: trashed.optional(), ...partial(cardProps) }))
          .min(1)
          .max(MAX_BATCH),
        stop_on_error: z.boolean().default(false),
        wait_seconds: waitSeconds,
      },
      annotations: UPDATE,
    },
    guarded(async ({ updates, stop_on_error, wait_seconds }) => {
      const items = updates.map(({ card_id, ...args }) => {
        const input = toCardInput(args);
        if (Object.keys(input).length === 0) throw new Error(`Update for ${card_id} has no attributes`);
        return { card_id, input };
      });
      const { job, deduplicated } = jobs.submit(
        "update_cards",
        items,
        async ({ card_id, input }) => summarizeCard(await updateCardMerged(card_id, input, "bulk")),
        { stopOnError: stop_on_error, dedupeKey: items },
      );
      return jobResult(job.job_id, wait_seconds, deduplicated ? { deduplicated: true } : {});
    }),
  );

  server.registerTool(
    "delete_cards",
    {
      title: "Delete cards (batch)",
      description:
        `Trashes (default, reversible) or permanently deletes up to ${MAX_BATCH} cards as a background job. ` +
        'mode="permanent" cannot be undone.',
      inputSchema: {
        card_ids: z.array(id("Card")).min(1).max(MAX_BATCH),
        mode: z.enum(["trash", "permanent"]).default("trash"),
        stop_on_error: z.boolean().default(false),
        wait_seconds: waitSeconds,
      },
      annotations: DESTRUCTIVE,
    },
    guarded(async ({ card_ids, mode, stop_on_error, wait_seconds }) => {
      const unique = [...new Set(card_ids)];
      const { job, deduplicated } = jobs.submit(
        mode === "permanent" ? "delete_cards" : "trash_cards",
        unique,
        async (cardId) => {
          if (mode === "permanent") await client.deleteCard(cardId, { priority: "bulk" });
          else await client.updateCard(cardId, { "trashed?": new Date().toJSON() }, { priority: "bulk" });
          return { id: cardId, [mode === "permanent" ? "deleted" : "trashed"]: true };
        },
        { stopOnError: stop_on_error, dedupeKey: unique },
      );
      return jobResult(job.job_id, wait_seconds, deduplicated ? { deduplicated: true } : {});
    }),
  );

  server.registerTool(
    "get_cards",
    {
      title: "Get cards (batch)",
      description: "Fetches up to 200 cards by ID as a background job. Returns the cards or a job_id for get_job.",
      inputSchema: {
        card_ids: z.array(id("Card")).min(1).max(200),
        wait_seconds: waitSeconds,
      },
      annotations: READ,
    },
    guarded(async ({ card_ids, wait_seconds }) => {
      const unique = [...new Set(card_ids)];
      const { job } = jobs.submit("get_cards", unique, (cardId) => client.getCard(cardId, { priority: "bulk" }));
      return jobResult(job.job_id, wait_seconds);
    }),
  );
}

/** Marks every schema in a shape optional. */
function partial<T extends Record<string, z.ZodType>>(shape: T): { [K in keyof T]: z.ZodOptional<T[K]> } {
  return Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.optional()])) as {
    [K in keyof T]: z.ZodOptional<T[K]>;
  };
}
