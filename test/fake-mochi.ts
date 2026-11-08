/**
 * In-memory Mochi API double. It enforces Mochi's one-concurrent-request rule
 * (answering overlapping requests with 429) and can inject 429s on demand.
 */
export class FakeMochi {
  cards = new Map<string, Record<string, unknown>>();
  decks = new Map<string, Record<string, unknown>>([["deck1", { id: "deck1", name: "Japanese" }]]);
  templates = new Map<string, Record<string, unknown>>();
  inFlight = 0;
  maxInFlight = 0;
  requests: string[] = [];
  concurrencyViolations = 0;
  rateLimitNext = 0;
  latencyMs = 2;
  private nextId = 1;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${url.pathname}`);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.inFlight > 1) {
        this.concurrencyViolations += 1;
        return json(429, { errors: ["Too many concurrent requests"] });
      }
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      if (this.rateLimitNext > 0) {
        this.rateLimitNext -= 1;
        return json(429, { errors: ["Rate limited"] }, { "retry-after": "0" });
      }
      return this.route(method, url, init?.body ? JSON.parse(String(init.body)) : undefined);
    } finally {
      this.inFlight -= 1;
    }
  };

  private route(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const [collection, id] = parts;
    if (collection === "decks" && !id && method === "GET") return json(200, { docs: [...this.decks.values()] });
    if (collection === "templates" && !id && method === "GET") return json(200, { docs: [...this.templates.values()] });
    if (collection === "templates" && id && method === "GET") {
      const template = this.templates.get(id);
      return template ? json(200, template) : json(404, { errors: ["Not found"] });
    }
    if (collection === "cards" && !id && method === "POST") {
      if (!body?.["deck-id"]) return json(422, { errors: { "deck-id": "required" } });
      const card = { ...body, id: `card${this.nextId++}` };
      this.cards.set(card.id, card);
      return json(200, card);
    }
    if (collection === "cards" && !id && method === "GET") {
      const deckId = url.searchParams.get("deck-id");
      const all = [...this.cards.values()].filter((card) => !deckId || card["deck-id"] === deckId);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const offset = Number(url.searchParams.get("bookmark") ?? 0);
      const docs = all.slice(offset, offset + limit);
      // Like Mochi, a bookmark may be returned even when no further documents exist.
      return json(200, { docs, bookmark: String(offset + docs.length) });
    }
    if (collection === "cards" && id) {
      const card = this.cards.get(id);
      if (!card) return json(404, { errors: ["Not found"] });
      if (method === "GET") return json(200, card);
      if (method === "POST") {
        Object.assign(card, body);
        return json(200, card);
      }
      if (method === "DELETE") {
        this.cards.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { errors: ["Unknown route"] });
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
