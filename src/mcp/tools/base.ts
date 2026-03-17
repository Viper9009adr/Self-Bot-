/**
 * src/mcp/tools/base.ts
 * BaseTool abstract class for all MCP tools.
 */
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { MCPToolDefinition, ToolResult, ToolContext, JsonObject } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import { childLogger } from '../../utils/logger.js';
import { normalizeError } from '../../utils/errors.js';

export abstract class BaseTool<TInput extends JsonObject = JsonObject>
  implements MCPToolDefinition<TInput>
{
  abstract readonly name: string;
  abstract readonly description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract readonly inputSchema: z.ZodType<TInput, any, any>;

  protected readonly log = childLogger({ module: `tool:${this.constructor.name}` });

  /**
   * Core implementation — override in subclasses.
   */
  protected abstract run(input: TInput, context: ToolContext): Promise<ToolResult>;

  /**
   * Execute the tool with timing, validation, and error handling.
   */
  async execute(input: TInput, context: ToolContext): Promise<ToolResult> {
    const startMs = Date.now();
    const log = this.log.child({
      toolName: this.name,
      taskId: context.taskId,
      userId: context.userId,
    });

    // Validate input
    const parsed = this.inputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return {
        success: false,
        data: null,
        error: `Invalid input: ${issues}`,
        errorCode: ToolErrorCode.INVALID_INPUT,
        durationMs: Date.now() - startMs,
      };
    }

    log.debug({ input: JSON.stringify(input).slice(0, 200) }, 'Tool executing');

    try {
      const result = await this.run(parsed.data, context);
      const durationMs = Date.now() - startMs;
      log.debug({ success: result.success, durationMs }, 'Tool completed');
      return { ...result, durationMs };
    } catch (err: unknown) {
      const durationMs = Date.now() - startMs;
      const normalized = normalizeError(err);
      log.error({ err: normalized.toJSON(), durationMs }, 'Tool threw');
      return {
        success: false,
        data: null,
        error: normalized.message,
        errorCode: ToolErrorCode.UNKNOWN,
        durationMs,
      };
    }
  }

  /**
   * Convert this tool to Vercel AI SDK tool format.
   */
  toAISdkTool(): {
    description: string;
    parameters: z.ZodType<TInput>;
    execute: (input: TInput) => Promise<ToolResult>;
  } {
    return {
      description: this.description,
      parameters: this.inputSchema,
      execute: (input: TInput) => {
        const context: ToolContext = {
          userId: 'system',
          taskId: `ai-${nanoid(8)}`,
          conversationId: 'system',
        };
        return this.execute(input, context);
      },
    };
  }
}
