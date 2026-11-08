import type { Card, Deck, MochiClient, Template } from "./client.js";

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_CARDS = 50_000;

export type MatchMode = "contains" | "exact" | "prefix" | "regex";

export interface SearchOptions {
  queries: string[];
  /** Restrict to these decks (IDs). Empty = whole account. */
  deckIds?: string[];
  includeSubdecks?: boolean;
  /** Field IDs or field names to search; empty = every field plus content. */
  fields?: string[];
  match?: MatchMode;
  tags?: string[];
  templateId?: string;
  includeTrashed?: boolean;
  includeArchived?: boolean;
  limitPerQuery?: number;
}

export interface CardHit {
  id: string;
  deck_id: string;
  deck?: string;
  template_id?: string;
  name?: string;
  matched_in: string[];
  snippet?: string;
  tags?: string[];
  archived?: boolean;
  trashed?: boolean;
  fields?: Record<string, string>;
}

export interface QueryResult {
  query: string;
  total: number;
  hits: CardHit[];
}

/** Normalises Japanese/Latin text for matching: NFKC, lower case, no tildes or whitespace. */
export function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[〜~～\s]/g, "");
}

/**
 * Mochi's API cannot search, only list cards page by page. This index loads
 * the requested decks (or the whole account) once through the rate-limited
 * queue, keeps cards in memory, and filters locally. Writes made through this
 * server update the index immediately; changes made elsewhere (the Mochi app)
 * appear after the TTL or a refresh.
 */
export class CardIndex {
  private readonly cards = new Map<string, Card>();
  private readonly deckLoadedAt = new Map<string, number>();
  private allLoadedAt = 0;
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly client: MochiClient,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    client.onCardChange((change) => {
      if (change.type === "delete") {
        this.cards.delete(change.cardId);
        return;
      }
      const existing = this.cards.get(change.card.id);
      this.cards.set(change.card.id, existing ? { ...existing, ...change.card } : change.card);
    });
  }

  private fresh(loadedAt: number | undefined): boolean {
    return loadedAt !== undefined && this.now() - loadedAt < this.ttlMs;
  }

  isLoaded(deckId?: string): boolean {
    if (this.fresh(this.allLoadedAt)) return true;
    return deckId !== undefined && this.fresh(this.deckLoadedAt.get(deckId));
  }

  /** Loads the given decks (or everything when undefined), sharing concurrent loads. */
  ensure(deckIds: string[] | undefined, refresh = false): Promise<void> {
    if (!deckIds) return this.load("*", refresh);
    return Promise.all(deckIds.map((id) => this.load(id, refresh))).then(() => undefined);
  }

  private load(key: string, refresh: boolean): Promise<void> {
    if (!refresh && this.isLoaded(key === "*" ? undefined : key)) return Promise.resolve();
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = (async () => {
      const startedAt = this.now();
      const { docs } = await this.client.listAllCards(
        { deckId: key === "*" ? undefined : key, maxCards: MAX_CARDS },
        { priority: "bulk" },
      );
      if (key === "*") {
        this.cards.clear();
        for (const card of docs) this.cards.set(card.id, card);
        this.allLoadedAt = startedAt;
      } else {
        for (const [id, card] of this.cards) if (card["deck-id"] === key) this.cards.delete(id);
        for (const card of docs) this.cards.set(card.id, card);
        this.deckLoadedAt.set(key, startedAt);
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  size(): number {
    return this.cards.size;
  }

  get(cardId: string): Card | undefined {
    return this.cards.get(cardId);
  }

  upsert(card: Card): void {
    this.cards.set(card.id, card);
  }

  remove(cardId: string): void {
    this.cards.delete(cardId);
  }

  /** Age of the oldest data covering the scope, in seconds (undefined if not loaded). */
  ageSeconds(deckIds: string[] | undefined): number | undefined {
    const now = this.now();
    if (this.fresh(this.allLoadedAt)) return Math.round((now - this.allLoadedAt) / 1000);
    if (!deckIds?.length) return undefined;
    const times = deckIds.map((id) => this.deckLoadedAt.get(id));
    if (times.some((time) => time === undefined)) return undefined;
    return Math.round((now - Math.min(...(times as number[]))) / 1000);
  }

  search(options: SearchOptions, decks: Deck[], templates: Map<string, Template>): QueryResult[] {
    const deckNames = deckPaths(decks);
    const scope = options.deckIds?.length ? new Set(expandDecks(options.deckIds, decks, options.includeSubdecks ?? true)) : undefined;
    const match = options.match ?? "contains";
    const limit = options.limitPerQuery ?? 50;
    const wantedTags = (options.tags ?? []).map((tag) => normalize(tag.replace(/^#/, "")));

    const candidates = [...this.cards.values()].filter((card) => {
      if (scope && !scope.has(card["deck-id"])) return false;
      if (!options.includeTrashed && card["trashed?"]) return false;
      if (!options.includeArchived && card["archived?"]) return false;
      if (options.templateId && card["template-id"] !== options.templateId) return false;
      if (wantedTags.length) {
        const cardTags = (card["manual-tags"] ?? []).map(normalize);
        if (!wantedTags.every((tag) => cardTags.includes(tag))) return false;
      }
      return true;
    });

    return options.queries.map((query) => {
      const test = matcher(query, match);
      const hits: CardHit[] = [];
      let total = 0;
      for (const card of candidates) {
        const matched: string[] = [];
        let snippet: string | undefined;
        for (const [label, value] of searchableValues(card, options.fields, templates)) {
          if (test(value)) {
            matched.push(label);
            snippet ??= value.length > 80 ? `${value.slice(0, 80)}…` : value;
          }
        }
        if (!matched.length) continue;
        total += 1;
        if (hits.length < limit) {
          hits.push({
            id: card.id,
            deck_id: card["deck-id"],
            deck: deckNames.get(card["deck-id"]),
            template_id: card["template-id"] ?? undefined,
            name: card.fields?.name?.value ?? firstLine(card.content),
            matched_in: matched,
            snippet,
            tags: card["manual-tags"]?.length ? card["manual-tags"] : undefined,
            archived: card["archived?"] || undefined,
            trashed: card["trashed?"] ? true : undefined,
          });
        }
      }
      return { query, total, hits };
    });
  }
}

function matcher(query: string, mode: MatchMode): (value: string) => boolean {
  if (mode === "regex") {
    const pattern = new RegExp(query, "iu");
    return (value) => pattern.test(value);
  }
  const needle = normalize(query);
  if (!needle) return () => false;
  if (mode === "exact") return (value) => normalize(value) === needle;
  if (mode === "prefix") return (value) => normalize(value).startsWith(needle);
  return (value) => normalize(value).includes(needle);
}

/** Yields [label, text] pairs for the requested fields (IDs or names); all fields and content by default. */
function searchableValues(card: Card, fields: string[] | undefined, templates: Map<string, Template>): Array<[string, string]> {
  const template = card["template-id"] ? templates.get(card["template-id"]) : undefined;
  const label = (fieldId: string) => template?.fields?.[fieldId]?.name ?? fieldId;
  const all: Array<[string, string, string]> = Object.entries(card.fields ?? {}).map(([id, field]) => [
    id,
    label(id),
    String(field?.value ?? ""),
  ]);
  if (typeof card.content === "string" && card.content) all.push(["content", "content", card.content]);
  if (!fields?.length) return all.map(([, name, value]) => [name, value]);
  const wanted = new Set(fields.map((field) => field.toLowerCase()));
  return all
    .filter(([id, name]) => wanted.has(id.toLowerCase()) || wanted.has(name.toLowerCase()))
    .map(([, name, value]) => [name, value]);
}

function firstLine(content: string | undefined): string | undefined {
  const line = content?.split("\n").find((part) => part.trim());
  return line ? line.slice(0, 80) : undefined;
}

export function deckPaths(decks: Deck[]): Map<string, string> {
  const byId = new Map(decks.map((deck) => [deck.id, deck]));
  const paths = new Map<string, string>();
  const resolve = (deck: Deck, depth = 0): string => {
    const parent = deck["parent-id"] ? byId.get(deck["parent-id"]) : undefined;
    return parent && depth < 20 ? `${resolve(parent, depth + 1)} :: ${deck.name}` : deck.name;
  };
  for (const deck of decks) paths.set(deck.id, resolve(deck));
  return paths;
}

export function expandDecks(deckIds: string[], decks: Deck[], includeSubdecks: boolean): string[] {
  const result = new Set(deckIds);
  if (!includeSubdecks) return [...result];
  let added = true;
  while (added) {
    added = false;
    for (const deck of decks) {
      if (deck["parent-id"] && result.has(deck["parent-id"]) && !result.has(deck.id)) {
        result.add(deck.id);
        added = true;
      }
    }
  }
  return [...result];
}
