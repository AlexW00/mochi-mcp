import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

test("search cache defaults to one week and is configurable", () => {
  assert.equal(loadConfig({ MOCHI_API_KEY: "k" }).searchCacheTtlMs, 7 * 24 * 3_600_000);
  assert.equal(loadConfig({ MOCHI_API_KEY: "k", MOCHI_SEARCH_CACHE_TTL_HOURS: "1" }).searchCacheTtlMs, 3_600_000);
  assert.equal(loadConfig({ MOCHI_API_KEY: "k", MOCHI_SEARCH_CACHE_TTL_HOURS: "0" }).searchCacheTtlMs, 0);
  assert.throws(() => loadConfig({ MOCHI_API_KEY: "k", MOCHI_SEARCH_CACHE_TTL_HOURS: "-1" }));
});
