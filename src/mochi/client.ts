import { MochiApiError, MochiQueue, parseRetryAfter, type Priority } from "./queue.js";

export interface Paginated<T> {
  docs: T[];
  bookmark?: string;
}

export interface FieldValue {
  id: string;
  value: string;
}

export interface Card {
  id: string;
  content: string;
  "deck-id": string;
  "template-id"?: string | null;
  "archived?"?: boolean;
  "review-reverse?"?: boolean;
  "trashed?"?: string | null;
  pos?: string;
  "manual-tags"?: string[];
  fields?: Record<string, FieldValue>;
  [key: string]: unknown;
}

export interface CardInput {
  content?: string;
  "deck-id"?: string;
  "template-id"?: string | null;
  "archived?"?: boolean;
  "review-reverse?"?: boolean;
  "trashed?"?: string | null;
  pos?: string;
  "manual-tags"?: string[];
  fields?: Record<string, FieldValue>;
}

export interface Deck {
  id: string;
  name: string;
  "parent-id"?: string | null;
  sort?: number;
  "archived?"?: boolean;
  "trashed?"?: string | null;
  [key: string]: unknown;
}

export interface DeckInput {
  name?: string;
  "parent-id"?: string | null;
  sort?: number;
  "archived?"?: boolean;
  "trashed?"?: string | null;
  "sort-by"?: string;
  "cards-view"?: string;
  "show-sides?"?: boolean;
  "sort-by-direction"?: boolean;
  "review-reverse?"?: boolean;
}

export interface Template {
  id: string;
  name: string;
  content: string;
  fields: Record<string, { id: string; name?: string; type?: string; pos?: string; options?: Record<string, unknown> }>;
  [key: string]: unknown;
}

export interface TemplateInput {
  name: string;
  content: string;
  pos?: string;
  fields: Record<string, { id: string; name?: string; type?: string; pos?: string; options?: Record<string, unknown> }>;
  style?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface DueCard {
  id: string;
  "deck-id"?: string;
  [key: string]: unknown;
}

export interface RequestOptions {
  priority?: Priority;
}

type FetchLike = typeof fetch;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const CACHE_TTL_MS = 5 * 60_000;

export type CardChange = { type: "upsert"; card: Card } | { type: "delete"; cardId: string };

/**
 * Mochi REST client. Every network call goes through the shared MochiQueue,
 * so concurrent MCP sessions and batch jobs never exceed Mochi's limits.
 * Rarely changing collections (decks, templates) are cached briefly and
 * invalidated by local writes, saving requests during batch work.
 */
export class MochiClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly authorization: string;
  private readonly cardListeners: Array<(change: CardChange) => void> = [];

  constructor(
    apiKey: string,
    readonly queue: MochiQueue,
    private readonly baseUrl = "https://app.mochi.cards/api",
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.authorization = "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    options: RequestOptions & { idempotent: boolean },
  ): Promise<T> {
    return this.queue.enqueue(
      async (signal) => {
        const headers: Record<string, string> = { Authorization: this.authorization, Accept: "application/json" };
        let payload: BodyInit | undefined;
        if (body instanceof FormData) {
          payload = body;
        } else if (body !== undefined) {
          headers["Content-Type"] = "application/json";
          payload = JSON.stringify(body);
        }
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: payload, signal });
        const text = await response.text();
        if (!response.ok) {
          throw new MochiApiError(response.status, text, parseRetryAfter(response.headers.get("retry-after")));
        }
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return { raw: text } as T;
        }
      },
      { priority: options.priority, idempotent: options.idempotent, label: `${method} ${path.split("?")[0]}` },
    );
  }

  private cached<T>(key: string, load: () => Promise<T>, refresh = false): Promise<T> {
    const entry = this.cache.get(key);
    if (!refresh && entry && entry.expiresAt > Date.now()) return Promise.resolve(entry.value as T);
    return load().then((value) => {
      this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    });
  }

  private invalidate(prefix: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  private async collectAll<T>(path: string, options: RequestOptions, maxPages = 50): Promise<T[]> {
    const docs: T[] = [];
    let bookmark: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const url = bookmark ? `${path}${separator}bookmark=${encodeURIComponent(bookmark)}` : path;
      const result = await this.request<Paginated<T>>("GET", url, undefined, { ...options, idempotent: true });
      docs.push(...(result.docs ?? []));
      // Mochi may return a bookmark even on the last page; stop on empty pages or repeats.
      if (!result.bookmark || !result.docs?.length || seen.has(result.bookmark)) break;
      seen.add(result.bookmark);
      bookmark = result.bookmark;
    }
    return docs;
  }

  /** Notifies listeners (the search index) about card writes made through this client. */
  onCardChange(listener: (change: CardChange) => void): void {
    this.cardListeners.push(listener);
  }

  private emit(change: CardChange): void {
    for (const listener of this.cardListeners) listener(change);
  }

  // Cards

  async createCard(input: CardInput, options: RequestOptions = {}): Promise<Card> {
    const card = await this.request<Card>("POST", "/cards", input, { ...options, idempotent: false });
    if (card?.id) this.emit({ type: "upsert", card });
    return card;
  }

  getCard(cardId: string, options: RequestOptions = {}): Promise<Card> {
    return this.request<Card>("GET", `/cards/${encodeURIComponent(cardId)}`, undefined, { ...options, idempotent: true });
  }

  listCards(
    params: { deckId?: string; limit?: number; bookmark?: string },
    options: RequestOptions = {},
  ): Promise<Paginated<Card>> {
    const query = new URLSearchParams();
    if (params.deckId) query.set("deck-id", params.deckId);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.bookmark) query.set("bookmark", params.bookmark);
    const suffix = query.size ? `?${query}` : "";
    return this.request<Paginated<Card>>("GET", `/cards${suffix}`, undefined, { ...options, idempotent: true });
  }

  async listAllCards(
    params: { deckId?: string; maxCards: number },
    options: RequestOptions = {},
  ): Promise<{ docs: Card[]; truncated: boolean }> {
    const docs: Card[] = [];
    let bookmark: string | undefined;
    const seen = new Set<string>();
    while (docs.length < params.maxCards) {
      const page = await this.listCards(
        { deckId: params.deckId, limit: Math.min(100, params.maxCards - docs.length), bookmark },
        options,
      );
      docs.push(...page.docs);
      if (!page.bookmark || page.docs.length === 0 || seen.has(page.bookmark)) {
        return { docs, truncated: false };
      }
      seen.add(page.bookmark);
      bookmark = page.bookmark;
    }
    return { docs, truncated: true };
  }

  /** Full-field update. Mochi applies the provided fields; repeating it is safe. */
  async updateCard(cardId: string, input: CardInput, options: RequestOptions = {}): Promise<Card> {
    const card = await this.request<Card>("POST", `/cards/${encodeURIComponent(cardId)}`, input, {
      ...options,
      idempotent: true,
    });
    if (card?.id) this.emit({ type: "upsert", card });
    return card;
  }

  async deleteCard(cardId: string, options: RequestOptions = {}): Promise<void> {
    await this.request<void>("DELETE", `/cards/${encodeURIComponent(cardId)}`, undefined, {
      ...options,
      idempotent: true,
    });
    this.emit({ type: "delete", cardId });
  }

  addAttachment(
    cardId: string,
    filename: string,
    data: Uint8Array,
    contentType: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const form = new FormData();
    form.append("file", new Blob([data as BlobPart], { type: contentType }), filename);
    return this.request(
      "POST",
      `/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(filename)}`,
      form,
      { ...options, idempotent: true },
    );
  }

  deleteAttachment(cardId: string, filename: string, options: RequestOptions = {}): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(filename)}`,
      undefined,
      { ...options, idempotent: true },
    );
  }

  // Decks

  listDecks(options: RequestOptions & { refresh?: boolean } = {}): Promise<Deck[]> {
    return this.cached("decks:list", () => this.collectAll<Deck>("/decks", options), options.refresh);
  }

  getDeck(deckId: string, options: RequestOptions = {}): Promise<Deck> {
    return this.request<Deck>("GET", `/decks/${encodeURIComponent(deckId)}`, undefined, { ...options, idempotent: true });
  }

  async createDeck(input: DeckInput, options: RequestOptions = {}): Promise<Deck> {
    const deck = await this.request<Deck>("POST", "/decks", input, { ...options, idempotent: false });
    this.invalidate("decks:");
    return deck;
  }

  async updateDeck(deckId: string, input: DeckInput, options: RequestOptions = {}): Promise<Deck> {
    try {
      return await this.request<Deck>("POST", `/decks/${encodeURIComponent(deckId)}`, input, {
        ...options,
        idempotent: true,
      });
    } finally {
      this.invalidate("decks:");
    }
  }

  async deleteDeck(deckId: string, options: RequestOptions = {}): Promise<void> {
    try {
      await this.request<void>("DELETE", `/decks/${encodeURIComponent(deckId)}`, undefined, {
        ...options,
        idempotent: true,
      });
    } finally {
      this.invalidate("decks:");
    }
  }

  // Templates

  listTemplates(options: RequestOptions & { refresh?: boolean } = {}): Promise<Template[]> {
    return this.cached("templates:list", () => this.collectAll<Template>("/templates", options), options.refresh);
  }

  getTemplate(templateId: string, options: RequestOptions & { refresh?: boolean } = {}): Promise<Template> {
    return this.cached(
      `templates:${templateId}`,
      () =>
        this.request<Template>("GET", `/templates/${encodeURIComponent(templateId)}`, undefined, {
          ...options,
          idempotent: true,
        }),
      options.refresh,
    );
  }

  async createTemplate(input: TemplateInput, options: RequestOptions = {}): Promise<Template> {
    const template = await this.request<Template>("POST", "/templates", input, { ...options, idempotent: false });
    this.invalidate("templates:");
    return template;
  }

  // Due

  getDueCards(params: { deckId?: string; date?: string }, options: RequestOptions = {}): Promise<Paginated<DueCard>> {
    const path = params.deckId ? `/due/${encodeURIComponent(params.deckId)}` : "/due";
    const query = params.date ? `?date=${encodeURIComponent(params.date)}` : "";
    return this.request<Paginated<DueCard>>("GET", `${path}${query}`, undefined, { ...options, idempotent: true });
  }
}
