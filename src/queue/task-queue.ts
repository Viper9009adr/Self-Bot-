/**
 * src/queue/task-queue.ts
 * p-queue wrapper with per-user concurrency enforcement.
 */
import PQueue from 'p-queue';
import type { Config } from '../config/index.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'queue:task-queue' });

export interface QueueMetrics {
  size: number;
  pending: number;
  concurrency: number;
}

export class TaskQueue {
  private readonly globalQueue: PQueue;
  private readonly userQueues = new Map<string, PQueue>();
  private readonly maxPerUserConcurrency: number;
  private jobCount = 0;
  private completedCount = 0;

  constructor(config: Config) {
    this.globalQueue = new PQueue({
      concurrency: config.queue.concurrency,
    });
    this.maxPerUserConcurrency = config.queue.perUserConcurrency;

    this.globalQueue.on('add', () => {
      this.jobCount++;
      log.trace({ size: this.globalQueue.size, pending: this.globalQueue.pending }, 'Job added');
    });

    this.globalQueue.on('completed', () => {
      this.completedCount++;
    });

    this.globalQueue.on('error', (err: unknown) => {
      log.error({ err }, 'Queue job error');
    });
  }

  /**
   * Enqueue a task on the global queue.
   */
  async enqueue<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    return this.globalQueue.add(fn, { priority }) as Promise<T>;
  }

  /**
   * Enqueue a task on a user-specific queue (per-user concurrency).
   */
  async enqueueForUser<T>(userId: string, fn: () => Promise<T>, priority = 0): Promise<T> {
    const userQueue = this.getUserQueue(userId);
    return userQueue.add(() => this.globalQueue.add(fn, { priority }) as Promise<T>, { priority }) as Promise<T>;
  }

  /**
   * Wait for all queued tasks to complete.
   */
  async drain(): Promise<void> {
    log.info({ size: this.globalQueue.size }, 'Draining task queue');
    await this.globalQueue.onIdle();
    log.info({ completed: this.completedCount }, 'Task queue drained');
  }

  /**
   * Clear all pending tasks.
   */
  clear(): void {
    this.globalQueue.clear();
    for (const queue of this.userQueues.values()) queue.clear();
    this.userQueues.clear();
  }

  /**
   * Pause the queue.
   */
  pause(): void {
    this.globalQueue.pause();
  }

  /**
   * Resume the queue.
   */
  resume(): void {
    this.globalQueue.start();
  }

  /**
   * Get metrics for monitoring.
   */
  getMetrics(): QueueMetrics {
    return {
      size: this.globalQueue.size,
      pending: this.globalQueue.pending,
      concurrency: this.globalQueue.concurrency,
    };
  }

  /**
   * Get or create a per-user queue.
   */
  private getUserQueue(userId: string): PQueue {
    let queue = this.userQueues.get(userId);
    if (!queue) {
      queue = new PQueue({ concurrency: this.maxPerUserConcurrency });
      queue.on('idle', () => {
        // Clean up empty user queues after they go idle
        setTimeout(() => {
          if (queue && queue.size === 0 && queue.pending === 0) {
            this.userQueues.delete(userId);
          }
        }, 5000);
      });
      this.userQueues.set(userId, queue);
    }
    return queue;
  }

  get size(): number {
    return this.globalQueue.size;
  }

  get pending(): number {
    return this.globalQueue.pending;
  }
}
