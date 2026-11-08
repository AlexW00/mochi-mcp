import { createHash, randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "succeeded" | "completed_with_errors" | "failed" | "cancelled";

export interface JobItemResult {
  index: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface JobSnapshot {
  job_id: string;
  kind: string;
  status: JobStatus;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  remaining: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  estimated_seconds_remaining?: number;
  deduplicated?: boolean;
  results?: JobItemResult[];
}

interface Job<T> {
  id: string;
  kind: string;
  fingerprint?: string;
  items: T[];
  status: JobStatus;
  results: JobItemResult[];
  succeeded: number;
  failed: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequested: boolean;
  stopOnError: boolean;
  done: Promise<void>;
}

export interface SubmitOptions {
  /** Identical submissions within the dedupe window return the existing job instead of repeating writes. */
  dedupeKey?: unknown;
  stopOnError?: boolean;
}

export interface JobManagerOptions {
  retentionMs?: number;
  maxJobs?: number;
  dedupeWindowMs?: number;
  /** Rough per-item duration used for progress estimates. */
  estimateItemMs?: () => number;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(["succeeded", "completed_with_errors", "failed", "cancelled"]);

/**
 * In-memory batch jobs. Each job submits one item at a time to the shared
 * Mochi queue at bulk priority, so interactive tool calls can interleave and
 * cancellation takes effect before the next item. Jobs survive the MCP request
 * that started them but not a process restart.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job<unknown>>();
  private readonly retentionMs: number;
  private readonly maxJobs: number;
  private readonly dedupeWindowMs: number;
  private readonly estimateItemMs: () => number;

  constructor(options: JobManagerOptions = {}) {
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60_000;
    this.maxJobs = options.maxJobs ?? 200;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 15 * 60_000;
    this.estimateItemMs = options.estimateItemMs ?? (() => 700);
  }

  submit<T>(
    kind: string,
    items: T[],
    worker: (item: T, index: number) => Promise<unknown>,
    options: SubmitOptions = {},
  ): { job: JobSnapshot; deduplicated: boolean } {
    this.prune();
    const fingerprint =
      options.dedupeKey === undefined
        ? undefined
        : createHash("sha256").update(kind).update(JSON.stringify(options.dedupeKey)).digest("hex");
    if (fingerprint) {
      for (const existing of this.jobs.values()) {
        const recent = Date.now() - existing.createdAt < this.dedupeWindowMs;
        if (existing.fingerprint === fingerprint && recent && existing.status !== "cancelled" && existing.status !== "failed") {
          return { job: { ...this.snapshot(existing, false), deduplicated: true }, deduplicated: true };
        }
      }
    }
    const job: Job<T> = {
      id: `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      kind,
      fingerprint,
      items,
      status: "queued",
      results: [],
      succeeded: 0,
      failed: 0,
      createdAt: Date.now(),
      cancelRequested: false,
      stopOnError: options.stopOnError ?? false,
      done: Promise.resolve(),
    };
    job.done = this.run(job, worker);
    this.jobs.set(job.id, job as Job<unknown>);
    return { job: this.snapshot(job as Job<unknown>, false), deduplicated: false };
  }

  private async run<T>(job: Job<T>, worker: (item: T, index: number) => Promise<unknown>): Promise<void> {
    await Promise.resolve();
    job.status = "running";
    job.startedAt = Date.now();
    for (let index = 0; index < job.items.length; index += 1) {
      if (job.cancelRequested) break;
      try {
        const value = await worker(job.items[index] as T, index);
        job.results.push({ index, ok: true, value });
        job.succeeded += 1;
      } catch (error) {
        job.results.push({ index, ok: false, error: error instanceof Error ? error.message : String(error) });
        job.failed += 1;
        if (job.stopOnError) break;
      }
    }
    job.finishedAt = Date.now();
    if (job.cancelRequested) job.status = "cancelled";
    else if (job.failed === 0 && job.succeeded === job.items.length) job.status = "succeeded";
    else if (job.succeeded === 0) job.status = "failed";
    else job.status = "completed_with_errors";
  }

  /** Waits up to `ms` for the job to finish. */
  async wait(jobId: string, ms: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL.has(job.status) || ms <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }

  get(jobId: string, includeResults = true): JobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job, includeResults) : undefined;
  }

  list(): JobSnapshot[] {
    this.prune();
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((job) => this.snapshot(job, false));
  }

  cancel(jobId: string): JobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (!TERMINAL.has(job.status)) job.cancelRequested = true;
    return this.snapshot(job, false);
  }

  activeCount(): number {
    return [...this.jobs.values()].filter((job) => !TERMINAL.has(job.status)).length;
  }

  private snapshot(job: Job<unknown>, includeResults: boolean): JobSnapshot {
    const completed = job.results.length;
    const remaining = TERMINAL.has(job.status) ? 0 : job.items.length - completed;
    return {
      job_id: job.id,
      kind: job.kind,
      status: job.cancelRequested && !TERMINAL.has(job.status) ? "running" : job.status,
      total: job.items.length,
      completed,
      succeeded: job.succeeded,
      failed: job.failed,
      remaining,
      created_at: new Date(job.createdAt).toISOString(),
      started_at: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
      finished_at: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
      estimated_seconds_remaining: remaining ? Math.ceil((remaining * this.estimateItemMs()) / 1000) : undefined,
      results: includeResults ? job.results : undefined,
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && now - job.finishedAt > this.retentionMs) this.jobs.delete(id);
    }
    if (this.jobs.size < this.maxJobs) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.finishedAt)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const job of finished) {
      if (this.jobs.size < this.maxJobs) break;
      this.jobs.delete(job.id);
    }
  }
}
