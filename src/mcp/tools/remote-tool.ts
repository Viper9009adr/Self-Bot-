/**
 * src/mcp/tools/remote-tool.ts
 * RemoteToolWrapper wraps a remote MCP tool as a BaseTool so it can be
 * registered in the local MCPToolRegistry and invoked by AgentCore.
 */
import { z } from 'zod';
import type { JsonObject, ToolContext, ToolResult } from '../../types/tool.js';
import type { MCPClient, RemoteToolSchema } from '../client.js';
import { BaseTool } from './base.js';
import { jsonSchemaToZod } from '../schema-utils.js';

/**
 * Adapts a remote MCP tool as a {@link BaseTool} so that it can be stored in
 * the local {@link MCPToolRegistry} and invoked transparently by AgentCore.
 *
 * The tool's name, description, and input schema are taken verbatim from the
 * {@link RemoteToolSchema} returned by the remote server. The JSON Schema
 * `inputSchema` is converted to a Zod schema via {@link jsonSchemaToZod} so
 * that the agent framework can validate arguments before dispatching.
 *
 * Execution delegates directly to {@link MCPClient.callTool}, which sends the
 * call over the existing Streamable HTTP transport.
 */
export class RemoteToolWrapper extends BaseTool<JsonObject> {
  readonly name: string;
  readonly description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly inputSchema: z.ZodType<JsonObject, any, any>;

  private readonly client: MCPClient;

  /**
   * @param client - Connected {@link MCPClient} for the server that owns this tool.
   * @param schema - Tool metadata as reported by the remote server.
   */
  constructor(client: MCPClient, schema: RemoteToolSchema) {
    super();
    this.client = client;
    this.name = schema.name;
    this.description = schema.description ?? '';
    this.inputSchema = jsonSchemaToZod(schema.inputSchema) as z.ZodType<
      JsonObject,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;
  }

  /**
   * Forward the validated input to the remote MCP server and return its result.
   */
  protected async run(input: JsonObject, context: ToolContext): Promise<ToolResult> {
    return this.client.callTool(this.name, input, context);
  }
}
