/**
 * src/queue/worker.ts
 * Worker: executes ToolCalls from the task queue.
 */
import type { MCPToolRegistry } from '../mcp/registry.js';
import type { ToolResult, ToolContext, JsonObject } from '../types/tool.js';
import { childLogger } from '../utils/logger.js';
import { nanoid } from 'nanoid';

const log = childLogger({ module: 'queue:worker' });

export interface ToolCallRequest {
  toolName: string;
  input: JsonObject;
  userId: string;
  conversationId: string;
  parentTaskId: string;
}

export interface ToolCallResult {
  requestId: string;
  toolName: string;
  result: ToolResult;
  durationMs: number;
}

/**
 * Worker that executes a single ToolCallRequest via the MCPToolRegistry.
 */
export class Worker {
  private readonly registry: MCPToolRegistry;
  private executedCount = 0;

  constructor(registry: MCPToolRegistry) {
    this.registry = registry;
  }

  /**
   * Execute a tool call request.
   */
  async execute(request: ToolCallRequest, signal?: AbortSignal): Promise<ToolCallResult> {
    const requestId = nanoid(12);
    const startMs = Date.now();

    const workerLog = log.child({
      requestId,
      toolName: request.toolName,
      userId: request.userId,
    });

    workerLog.debug({ input: JSON.stringify(request.input).slice(0, 200) }, 'Worker executing tool');

    const context: ToolContext = {
      userId: request.userId,
      taskId: requestId,
      conversationId: request.conversationId,
      signal,
      logger: workerLog,
    };

    const result = await this.registry.execute(request.toolName, request.input, context);
    const durationMs = Date.now() - startMs;

    this.executedCount++;
    workerLog.debug({ success: result.success, durationMs }, 'Worker finished');

    return {
      requestId,
      toolName: request.toolName,
      result,
      durationMs,
    };
  }

  /**
   * Number of tool calls executed by this worker.
   */
  get totalExecuted(): number {
    return this.executedCount;
  }
}
