import type { QueueConfig } from "../config.js";

export type Priority = "interactive" | "bulk";

/** Error raised for non-2xx Mochi responses. */
export class MochiApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Mochi API error (${status}): ${body.slice(0, 500)}`);
    this.name = "MochiApiError";
  }
}

export class QueueFullError extends Error {
  constructor(limit: number) {
    super(`Mochi request queue is full (${limit} pending). Retry later or use a smaller batch.`);
    this.name = "QueueFullError";
  }
}

export interface EnqueueOptions {
  priority?: Priority;
  /** Safe to repeat after timeouts, network errors and 5xx responses (reads, deletes, full updates). */
  idempotent?: boolean;
  label?: string;
}

interface Task<T> {
  run: (signal: AbortSignal) => Promise<T>;
  options: Required<Omit<EnqueueOptions, "label">> & { label: string };
  enqueuedAt: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export interface QueueStats {
  pending: { interactive: number; bulk: number };
  running: boolean;
  currentIntervalMs: number;
  completed: number;
  failed: number;
  retries: number;
  rateLimited: number;
  lastRateLimitedAt?: string;
  lastErrorAt?: string;
  averageWaitMs: number;
}

export interface QueueDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Serialises every Mochi API call for one account.
 *
 * Mochi allows one concurrent request per account and answers bursts with 429.
 * This queue runs exactly one request at a time, keeps a minimum gap between
 * requests, prefers interactive calls over background batch work, and adapts
 * the gap when Mochi signals rate limiting (multiplicative increase, gradual
 * decrease). 429 responses are always retried because Mochi rejected them
 * without processing; other failures are retried only for idempotent calls.
 */
export class MochiQueue {
  private readonly interactive: Task<unknown>[] = [];
  private readonly bulk: Task<unknown>[] = [];
  private running = false;
  private intervalMs: number;
  private lastFinishedAt = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: NonNullable<QueueDeps["log"]>;
  private stats = { completed: 0, failed: 0, retries: 0, rateLimited: 0, waitTotal: 0, waitCount: 0 };
  private lastRateLimitedAt?: number;
  private lastErrorAt?: number;

  constructor(
    private readonly config: QueueConfig,
    deps: QueueDeps = {},
  ) {
    this.intervalMs = config.minIntervalMs;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
  }

  enqueue<T>(run: (signal: AbortSignal) => Promise<T>, options: EnqueueOptions = {}): Promise<T> {
    if (this.interactive.length + this.bulk.length >= this.config.maxPending) {
      return Promise.reject(new QueueFullError(this.config.maxPending));
    }
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = {
        run,
        options: {
          priority: options.priority ?? "interactive",
          idempotent: options.idempotent ?? false,
          label: options.label ?? "request",
        },
        enqueuedAt: this.now(),
        resolve,
        reject,
      };
      (task.options.priority === "interactive" ? this.interactive : this.bulk).push(task as Task<unknown>);
      void this.pump();
    });
  }

  getStats(): QueueStats {
    return {
      pending: { interactive: this.interactive.length, bulk: this.bulk.length },
      running: this.running,
      currentIntervalMs: Math.round(this.intervalMs),
      completed: this.stats.completed,
      failed: this.stats.failed,
      retries: this.stats.retries,
      rateLimited: this.stats.rateLimited,
      lastRateLimitedAt: this.lastRateLimitedAt ? new Date(this.lastRateLimitedAt).toISOString() : undefined,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : undefined,
      averageWaitMs: this.stats.waitCount ? Math.round(this.stats.waitTotal / this.stats.waitCount) : 0,
    };
  }

  /** Rough number of milliseconds until a newly queued request of this priority would start. */
  estimateWaitMs(priority: Priority = "interactive"): number {
    const ahead = priority === "interactive" ? this.interactive.length : this.interactive.length + this.bulk.length;
    return Math.round((ahead + (this.running ? 1 : 0)) * (this.intervalMs + 400));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const task = this.interactive.shift() ?? this.bulk.shift();
        if (!task) break;
        await this.execute(task);
      }
    } finally {
      this.running = false;
    }
  }

  private async waitForSlot(): Promise<void> {
    const wait = this.lastFinishedAt + this.intervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private async execute(task: Task<unknown>): Promise<void> {
    this.stats.waitTotal += this.now() - task.enqueuedAt;
    this.stats.waitCount += 1;
    for (let attempt = 0; ; attempt += 1) {
      await this.waitForSlot();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("Mochi request timed out")), this.config.requestTimeoutMs);
      try {
        const value = await task.run(controller.signal);
        this.lastFinishedAt = this.now();
        // Recover gradually after rate limiting.
        this.intervalMs = Math.max(this.config.minIntervalMs, this.intervalMs * 0.85);
        this.stats.completed += 1;
        task.resolve(value);
        return;
      } catch (error) {
        this.lastFinishedAt = this.now();
        const decision = this.retryDecision(error, task, attempt);
        if (!decision.retry) {
          this.stats.failed += 1;
          this.lastErrorAt = this.now();
          task.reject(error);
          return;
        }
        this.stats.retries += 1;
        this.log("mochi request retry", {
          label: task.options.label,
          attempt: attempt + 1,
          delayMs: decision.delayMs,
          reason: error instanceof MochiApiError ? `status ${error.status}` : errorName(error),
        });
        await this.sleep(decision.delayMs);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private retryDecision(error: unknown, task: Task<unknown>, attempt: number): { retry: boolean; delayMs: number } {
    if (attempt >= this.config.maxRetries) return { retry: false, delayMs: 0 };
    const backoff = Math.min(this.config.maxIntervalMs, 1_000 * 2 ** attempt) * (0.75 + this.random() * 0.5);
    if (error instanceof MochiApiError && error.status === 429) {
      this.stats.rateLimited += 1;
      this.lastRateLimitedAt = this.now();
      this.intervalMs = Math.min(this.config.maxIntervalMs, Math.max(this.intervalMs * 2, 1_000));
      return { retry: true, delayMs: Math.max(error.retryAfterMs ?? 0, backoff) };
    }
    if (!task.options.idempotent) return { retry: false, delayMs: 0 };
    if (error instanceof MochiApiError) {
      return error.status >= 500 ? { retry: true, delayMs: backoff } : { retry: false, delayMs: 0 };
    }
    // Network errors and timeouts.
    return { retry: true, delayMs: backoff };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 600_000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - now), 600_000);
}
