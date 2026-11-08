import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeps, createMcpServer } from "../src/server.js";
import { FakeMochi } from "./fake-mochi.js";

let mochi: FakeMochi;
let client: Client;

function kanjiCard(id: string, kanji: string, meaning: string, deck = "kanji") {
  return { id, "deck-id": deck, "template-id": "tplKanji", content: "", fields: { name: { id: "name", value: kanji }, mng: { id: "mng", value: meaning } } };
}

beforeEach(async () => {
  mochi = new FakeMochi();
  mochi.latencyMs = 0;
  mochi.decks.set("kanji", { id: "kanji", name: "02 - kanji" });
  mochi.decks.set("kanjiSub", { id: "kanjiSub", name: "radicals", "parent-id": "kanji" });
  mochi.decks.set("inbox", { id: "inbox", name: "00 - inbox" });
  mochi.templates.set("tplKanji", { id: "tplKanji", name: "Japanese Kanji", content: "", fields: { name: { id: "name", name: "kanji" }, mng: { id: "mng", name: "meaning" } } });
  for (let i = 0; i < 150; i += 1) mochi.cards.set(`k${i}`, kanjiCard(`k${i}`, String.fromCodePoint(0x4e00 + i), `meaning ${i}`));
  mochi.cards.set("r1", kanjiCard("r1", "氵", "Wasser-Radikal", "kanjiSub"));
  mochi.cards.set("w1", kanjiCard("w1", "水", "Wasser", "inbox"));
  const deps = createDeps(
    { mochiApiKey: "key", mochiBaseUrl: "https://mochi.test/api", queue: { minIntervalMs: 0, maxIntervalMs: 10, maxRetries: 3, requestTimeoutMs: 5_000, maxPending: 1_000 } },
    { sleep: () => Promise.resolve() },
    mochi.fetch,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(deps).connect(serverTransport);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
});

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.ok(!result.isError, result.content[0]?.text);
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

const listRequests = () => mochi.requests.filter((request) => request === "GET /api/cards").length;

test("finds cards across paginated decks and subdecks, many terms at once", async () => {
  const result = await call("search_cards", { queries: ["一", "氵", "水"], deck_ids: ["kanji"], fields: ["kanji"], match: "exact" });
  assert.equal(result.complete, true);
  const [first, radical, water] = result.results;
  assert.equal(first.total, 1);
  assert.equal(first.hits[0].id, "k0");
  assert.equal(first.hits[0].deck, "02 - kanji");
  assert.equal(radical.hits[0].deck, "02 - kanji :: radicals", "subdecks included");
  assert.equal(water.total, 0, "inbox deck out of scope");
  assert.equal(result.indexed_cards, 151, "both pages of the 150-card deck loaded");
});

test("searches by field name and content-insensitive matching", async () => {
  const result = await call("search_cards", { query: "wasser", fields: ["meaning"] });
  assert.deepEqual(result.hits.map((hit: { id: string }) => hit.id).sort(), ["r1", "w1"]);
  assert.deepEqual(result.hits[0].matched_in, ["meaning"]);
});

test("repeat searches use the cache; writes through the server stay in sync", async () => {
  await call("search_cards", { query: "水", deck_ids: ["inbox", "kanji"] });
  const afterFirst = listRequests();
  await call("update_cards", { updates: [{ card_id: "w1", deck_id: "kanji" }], wait_seconds: 5 });
  const moved = await call("search_cards", { query: "水", deck_ids: ["kanji"], fields: ["kanji"] });
  assert.equal(listRequests(), afterFirst, "no reload needed");
  assert.equal(moved.hits[0].deck_id, "kanji", "move reflected immediately");
  assert.equal(typeof moved.index_age_seconds, "number");
});

test("external edits: stale until verify or refresh", async () => {
  await call("search_cards", { query: "水", deck_ids: ["inbox"] });
  mochi.cards.delete("w1"); // deleted in the Mochi app
  mochi.cards.set("w2", kanjiCard("w2", "水曜日", "Mittwoch", "inbox")); // created in the Mochi app
  const stale = await call("search_cards", { query: "水", deck_ids: ["inbox"] });
  assert.deepEqual(stale.hits.map((hit: { id: string }) => hit.id), ["w1"], "cache is stale by design");
  const verified = await call("search_cards", { query: "水", deck_ids: ["inbox"], verify: true });
  assert.equal(verified.total, 0, "verify drops the deleted card");
  const refreshed = await call("search_cards", { query: "水", deck_ids: ["inbox"], refresh: true });
  assert.deepEqual(refreshed.hits.map((hit: { id: string }) => hit.id), ["w2"], "refresh finds the new card");
});

test("returns full fields on request", async () => {
  const result = await call("search_cards", { query: "氵", include_fields: true });
  assert.deepEqual(result.hits[0].fields, { kanji: "氵", meaning: "Wasser-Radikal" });
});

test("partial field updates keep the other fields", async () => {
  await call("update_card", { card_id: "w1", fields: { mng: "Wasser (neu)" } });
  const fields = mochi.cards.get("w1")?.fields as Record<string, { value: string }>;
  assert.equal(fields.mng?.value, "Wasser (neu)");
  assert.equal(fields.name?.value, "水", "primary field preserved");
});

test("long loads return partial progress instead of blocking", async () => {
  mochi.latencyMs = 30;
  const first = await call("search_cards", { query: "一", deck_ids: ["kanji"], wait_seconds: 0 });
  assert.equal(first.complete, false);
  assert.match(first.next_step, /again/);
  let done = first;
  for (let i = 0; i < 50 && !done.complete; i += 1) done = await call("search_cards", { query: "一", deck_ids: ["kanji"], wait_seconds: 1 });
  assert.equal(done.complete, true);
  assert.equal(done.total, 1);
});
