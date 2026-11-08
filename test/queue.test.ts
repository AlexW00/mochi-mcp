import assert from "node:assert/strict";
import { test } from "node:test";
import { MochiApiError, MochiQueue, parseRetryAfter, QueueFullError } from "../src/mochi/queue.js";

const config = { minIntervalMs: 0, maxIntervalMs: 50, maxRetries: 3, requestTimeoutMs: 1_000, maxPending: 100 };
const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

test("runs one request at a time", async () => {
  const queue = new MochiQueue(config, fast);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      queue.enqueue(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 1);
  assert.equal(queue.getStats().completed, 20);
});

test("interactive requests overtake queued bulk work", async () => {
  const queue = new MochiQueue(config, fast);
  const order: string[] = [];
  const task = (name: string) => async () => {
    order.push(name);
  };
  const all = [
    queue.enqueue(task("bulk1"), { priority: "bulk" }),
    queue.enqueue(task("bulk2"), { priority: "bulk" }),
    queue.enqueue(task("bulk3"), { priority: "bulk" }),
    queue.enqueue(task("interactive"), { priority: "interactive" }),
  ];
  await Promise.all(all);
  // bulk1 starts immediately; the interactive call runs before the remaining bulk items.
  assert.deepEqual(order, ["bulk1", "interactive", "bulk2", "bulk3"]);
});

test("retries 429 even for non-idempotent requests and slows down", async () => {
  const sleeps: number[] = [];
  const queue = new MochiQueue({ ...config, minIntervalMs: 10, maxIntervalMs: 10_000 }, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  let calls = 0;
  const result = await queue.enqueue(async () => {
    calls += 1;
    if (calls < 3) throw new MochiApiError(429, "slow down", 2_000);
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.ok(sleeps.some((ms) => ms >= 2_000), "honours Retry-After");
  const stats = queue.getStats();
  assert.equal(stats.rateLimited, 2);
  assert.ok(stats.currentIntervalMs > 10, "adaptive interval increased");
});

test("does not retry non-idempotent requests after server errors", async () => {
  const queue = new MochiQueue(config, fast);
  let calls = 0;
  await assert.rejects(
    queue.enqueue(async () => {
      calls += 1;
      throw new MochiApiError(500, "boom");
    }),
    /500/,
  );
  assert.equal(calls, 1);
});

test("retries idempotent requests after server errors", async () => {
  const queue = new MochiQueue(config, fast);
  let calls = 0;
  const value = await queue.enqueue(
    async () => {
      calls += 1;
      if (calls === 1) throw new MochiApiError(503, "unavailable");
      return 42;
    },
    { idempotent: true },
  );
  assert.equal(value, 42);
  assert.equal(calls, 2);
});

test("never retries client errors", async () => {
  const queue = new MochiQueue(config, fast);
  let calls = 0;
  await assert.rejects(
    queue.enqueue(
      async () => {
        calls += 1;
        throw new MochiApiError(422, "invalid");
      },
      { idempotent: true },
    ),
  );
  assert.equal(calls, 1);
});

test("gives up after maxRetries", async () => {
  const queue = new MochiQueue({ ...config, maxRetries: 2 }, fast);
  let calls = 0;
  await assert.rejects(
    queue.enqueue(async () => {
      calls += 1;
      throw new MochiApiError(429, "nope");
    }),
  );
  assert.equal(calls, 3);
});

test("rejects work beyond maxPending", async () => {
  const queue = new MochiQueue({ ...config, maxPending: 2 }, fast);
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => (release = resolve));
  const first = queue.enqueue(() => blocker); // running, not pending
  const second = queue.enqueue(async () => 2);
  const third = queue.enqueue(async () => 3);
  await assert.rejects(queue.enqueue(async () => 4), QueueFullError);
  release();
  await Promise.all([first, second, third]);
});

test("parses Retry-After seconds and dates", () => {
  assert.equal(parseRetryAfter("3"), 3_000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("garbage"), undefined);
});
