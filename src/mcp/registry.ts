/**
 * src/mcp/registry.ts
 * MCPToolRegistry: register and execute MCP tools.
 */
import type { MCPToolDefinition, ToolResult, ToolContext, JsonObject } from '../types/tool.js';
import { ToolErrorCode } from '../types/tool.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'mcp:registry' });

export class MCPToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<string, MCPToolDefinition<any>>();

  /**
   * Register a tool. Throws if a tool with the same name is already registered.
   */
  register<T extends JsonObject>(tool: MCPToolDefinition<T>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
    log.debug({ tool: tool.name }, 'Tool registered');
  }

  /**
   * Register multiple tools.
   */
  registerAll(tools: MCPToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  /**
   * Get a registered tool by name.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): MCPToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute a named tool with provided input and context.
   */
  async execute(
    toolName: string,
    input: JsonObject,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      log.warn({ toolName }, 'Tool not found');
      return {
        success: false,
        data: null,
        error: `Tool '${toolName}' not found`,
        errorCode: ToolErrorCode.TOOL_NOT_FOUND,
      };
    }

    return tool.execute(input, context);
  }

  /**
   * List all registered tool names.
   */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all tools as an array (for iteration).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listAll(): MCPToolDefinition<any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Export all tools in Vercel AI SDK tool format.
   * Used when passing tools to streamText().
   */
  toAISdkTools(): Record<
    string,
    {
      description: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: any;
      execute: (input: JsonObject) => Promise<ToolResult>;
    }
  > {
    const result: Record<string, {
      description: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: any;
      execute: (input: JsonObject) => Promise<ToolResult>;
    }> = {};

    for (const [name, tool] of this.tools) {
      result[name] = {
        description: tool.description,
        parameters: tool.inputSchema,
        execute: (input) => tool.execute(input, {
          userId: 'system',
          taskId: `ai-${name}`,
          conversationId: 'system',
        }),
      };
    }

    return result;
  }

  /**
   * Export tool manifests for LLM system prompt injection.
   */
  toManifest(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /** Number of registered tools */
  get size(): number {
    return this.tools.size;
  }
}
