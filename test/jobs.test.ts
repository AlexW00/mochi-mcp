import assert from "node:assert/strict";
import { test } from "node:test";
import { JobManager } from "../src/jobs.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test("runs items sequentially and records per-item results", async () => {
  const jobs = new JobManager();
  const seen: number[] = [];
  const { job } = jobs.submit("demo", [1, 2, 3], async (item) => {
    seen.push(item);
    if (item === 2) throw new Error("bad item");
    return item * 10;
  });
  await jobs.wait(job.job_id, 1_000);
  const done = jobs.get(job.job_id)!;
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(done.status, "completed_with_errors");
  assert.equal(done.succeeded, 2);
  assert.equal(done.failed, 1);
  assert.equal(done.results?.[1]?.error, "bad item");
  assert.equal(done.results?.[2]?.value, 30);
});

test("stop_on_error halts the job", async () => {
  const jobs = new JobManager();
  const { job } = jobs.submit("demo", [1, 2, 3], async (item) => {
    if (item === 1) throw new Error("first fails");
  }, { stopOnError: true });
  await jobs.wait(job.job_id, 1_000);
  const done = jobs.get(job.job_id)!;
  assert.equal(done.status, "failed");
  assert.equal(done.completed, 1);
});

test("identical submissions are deduplicated", async () => {
  const jobs = new JobManager();
  let calls = 0;
  const worker = async () => {
    calls += 1;
  };
  const first = jobs.submit("create", [{ a: 1 }], worker, { dedupeKey: [{ a: 1 }] });
  const second = jobs.submit("create", [{ a: 1 }], worker, { dedupeKey: [{ a: 1 }] });
  assert.equal(second.deduplicated, true);
  assert.equal(second.job.job_id, first.job.job_id);
  const different = jobs.submit("create", [{ a: 2 }], worker, { dedupeKey: [{ a: 2 }] });
  assert.equal(different.deduplicated, false);
  await jobs.wait(first.job.job_id, 1_000);
  await jobs.wait(different.job.job_id, 1_000);
  assert.equal(calls, 2);
});

test("cancel stops before the next item", async () => {
  const jobs = new JobManager();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const processed: number[] = [];
  const { job } = jobs.submit("slow", [1, 2, 3], async (item) => {
    processed.push(item);
    if (item === 1) await gate;
  });
  await tick();
  jobs.cancel(job.job_id);
  release();
  await jobs.wait(job.job_id, 1_000);
  assert.deepEqual(processed, [1]);
  assert.equal(jobs.get(job.job_id)?.status, "cancelled");
});

test("wait returns early with progress for long jobs", async () => {
  const jobs = new JobManager();
  const { job } = jobs.submit("slow", [1, 2], () => new Promise((resolve) => setTimeout(resolve, 200)));
  await jobs.wait(job.job_id, 10);
  const snapshot = jobs.get(job.job_id)!;
  assert.equal(snapshot.status, "running");
  assert.ok(snapshot.remaining > 0);
  jobs.cancel(job.job_id);
});
