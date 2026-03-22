import type { Api } from 'grammy';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'agent:progress-reporter' });

/**
 * ProgressReporter — sends a single Telegram message at task start
 * and edits it live with per-step start/done status lines.
 *
 * Each step occupies one line in the message. onStepStart inserts the line;
 * onStepDone replaces it with a ✓ done line. Interrupted steps are marked ⚠.
 *
 * Known limitation: Telegram throttles editMessageText to ~20/sec globally.
 * Rapid tool chains may trigger 429 errors; these are silently ignored.
 *
 * Usage:
 *   const reporter = new ProgressReporter(api, chatId)
 *   await reporter.init()
 *   // pass reporter.onStepStart / reporter.onStepDone as hooks to AgentCore
 *   try { ... } finally { await reporter.cleanup().catch(() => undefined) }
 */
export class ProgressReporter {
  private readonly api: Api;
  private readonly chatId: number;
  private readonly mode: 'single' | 'history';
  private messageId: number | null = null;
  private failed = false;

  /** Ordered list of display lines (one per step). */
  private lines: string[] = [];
  /** Maps stepN → zero-based index in this.lines */
  private lineIndexMap: Map<number, number> = new Map();
  /** Maps stepN → start timestamp (ms) for duration calculation */
  private stepTimers: Map<number, number> = new Map();

  constructor(api: Api, chatId: number, mode: 'single' | 'history' = 'history') {
    this.api = api;
    this.chatId = chatId;
    this.mode = mode;
  }

  /**
   * Send the initial "⏳ Working…" indicator message.
   * Captures message_id for subsequent edits.
   * On failure: sets this.failed = true, logs, does NOT throw.
   */
  async init(): Promise<void> {
    try {
      const msg = await this.api.sendMessage(this.chatId, '⏳ Working…');
      this.messageId = msg.message_id;
    } catch (err) {
      this.failed = true;
      log.warn({ err, chatId: this.chatId }, 'ProgressReporter: failed to send indicator');
    }
  }

  /**
   * Called when a tool step begins.
   * Appends a new "⚙ Step N — <description>" line and edits the message.
   */
  async onStepStart(stepN: number, toolName: string, args: Record<string, unknown>): Promise<void> {
    if (this.failed || this.messageId === null) return;

    this.stepTimers.set(stepN, Date.now());
    const description = this.describeStep(toolName, args);
    const line = `⚙ Step ${stepN} — ${description}`;

    if (this.mode === 'single') {
      this.lines = [line];
      this.lineIndexMap.set(stepN, 0);
    } else {
      this.lines.push(line);
      this.lineIndexMap.set(stepN, this.lines.length - 1);
    }

    await this.editMessage();
  }

  /**
   * Called when a tool step finishes.
   * Replaces the corresponding start line with "✓ Step N done (Xms) — <summary>".
   */
  async onStepDone(stepN: number, toolName: string, durationMs: number, result: unknown): Promise<void> {
    if (this.failed || this.messageId === null) return;

    const summary = this.summarizeResult(toolName, result);
    const doneLine = `✓ Step ${stepN} done (${durationMs}ms) — ${summary}`;

    if (this.mode === 'single') {
      this.lines = [doneLine];
      this.lineIndexMap.set(stepN, 0);
      await this.editMessage();
      return;
    }

    const lineIndex = this.lineIndexMap.get(stepN);
    if (lineIndex !== undefined) {
      this.lines[lineIndex] = doneLine;
    } else {
      // Defensive: stepN not found — append
      this.lines.push(doneLine);
    }

    await this.editMessage();
  }

  /**
   * Attempt to replace the progress message with final assistant response.
   * Returns true only when Telegram edit succeeds end-to-end.
   */
  async finalizeToResponse(finalText: string, format: 'text' | 'markdown'): Promise<boolean> {
    if (this.failed || this.messageId === null) return false;
    if (finalText.length > 4096) return false;

    try {
      await this.api.editMessageText(this.chatId, this.messageId, finalText, {
        ...(format === 'markdown' ? { parse_mode: 'Markdown' as const } : {}),
      });
      return true;
    } catch (err) {
      log.debug({ err, chatId: this.chatId }, 'ProgressReporter: finalize edit skipped');
      return false;
    }
  }

  /**
   * Replace any remaining ⚙ lines with ⚠ Step N interrupted,
   * then edit the message in place. Does NOT delete the message.
   */
  async cleanup(): Promise<void> {
    if (this.failed || this.messageId === null) return;

    if (this.mode === 'single') {
      return;
    }

    // Replace all pending ⚙ start lines with interrupted markers
    for (const [stepN, lineIndex] of this.lineIndexMap.entries()) {
      const current = this.lines[lineIndex];
      if (current !== undefined && current.startsWith('⚙')) {
        this.lines[lineIndex] = `⚠ Step ${stepN} interrupted`;
      }
    }

    // Edit the message to reflect final state (do not delete)
    if (this.lines.length > 0) {
      await this.editMessage();
    }

    this.messageId = null;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Render all lines into a single message string and edit the Telegram message.
   */
  private async editMessage(): Promise<void> {
    const text = this.renderMessage();
    try {
      await this.api.editMessageText(this.chatId, this.messageId!, text);
    } catch (err) {
      // 400 on identical text or 429 throttle — both acceptable, never propagate
      log.debug({ err, chatId: this.chatId }, 'ProgressReporter: edit skipped');
    }
  }

  /**
   * Build the full message text from current lines.
   * Falls back to "⏳ Working…" if no lines yet.
   */
  private renderMessage(): string {
    if (this.lines.length === 0) return '⏳ Working…';
    return this.lines.join('\n');
  }

  /**
   * Human-readable description of what a tool step does.
   */
  private describeStep(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'scrape_website':
        return `fetching ${args.url ?? 'page'}`;
      case 'fill_form':
        return `filling form on ${args.url ?? 'page'}`;
      case 'login_account':
        return `logging in to ${args.url ?? 'site'}`;
      case 'register_account':
        return `registering on ${args.url ?? 'site'}`;
      case 'book_appointment':
        return `booking appointment at ${args.url ?? 'site'}`;
      default: {
        const urlSuffix = typeof args?.url === 'string' ? ` on ${args.url}` : '';
        return `running ${toolName}${urlSuffix}`;
      }
    }
  }

  /**
   * One-line summary of a tool result for display in the done line.
   */
  private summarizeResult(_toolName: string, result: unknown): string {
    if (typeof result !== 'object' || result === null) return 'done';

    const r = result as Record<string, unknown>;
    if (typeof r.summary === 'string' && r.summary.length > 0) {
      return r.summary;
    }

    return 'done';
  }
}
