/**
 * src/mcp/client.ts
 * MCP client wrapper used by AgentCore to call remote MCP tools.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolResult, ToolContext, JsonObject, JsonSerializable } from '../types/tool.js';
import { ToolErrorCode } from '../types/tool.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'mcp:client' });

/** Configuration passed to {@link MCPClient} at construction time. */
export interface MCPClientOptions {
  /** Base URL of the remote MCP server (e.g. `https://mcp.example.com`). The client appends `/mcp` automatically. */
  serverUrl: string;
  /** Name sent in the MCP client handshake. Defaults to `"self-bot-client"`. */
  clientName?: string;
  /** Version sent in the MCP client handshake. Defaults to `"0.1.0"`. */
  clientVersion?: string;
}

/**
 * Minimal tool descriptor returned by {@link MCPClient.listToolsWithSchema}.
 * Mirrors the relevant fields of the MCP SDK `Tool` type, kept narrow so
 * callers are not coupled to SDK internals.
 */
export interface RemoteToolSchema {
  /** Unique tool name as declared by the remote server. */
  name: string;
  /** Human-readable description of what the tool does. */
  description?: string;
  /** JSON Schema object describing the tool's accepted input. */
  inputSchema: Record<string, unknown>;
}

/**
 * Thin wrapper around the MCP SDK `Client` that manages a single Streamable
 * HTTP connection to a remote MCP server.
 *
 * Typical lifecycle:
 * 1. `new MCPClient({ serverUrl })` — construct (no I/O yet)
 * 2. `await client.connect()` — establish the transport and perform handshake
 * 3. `await client.callTool(...)` / `await client.listToolsWithSchema()` — use
 * 4. `await client.disconnect()` — close the transport gracefully
 */
export class MCPClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;
  private readonly options: MCPClientOptions;

  constructor(options: MCPClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const mcpUrl = new URL('/mcp', this.options.serverUrl);
    this.transport = new StreamableHTTPClientTransport(mcpUrl);

    this.client = new Client(
      {
        name: this.options.clientName ?? 'self-bot-client',
        version: this.options.clientVersion ?? '0.1.0',
      },
      {
        // No special capabilities required for calling tools as a client
        capabilities: {},
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.client.connect(this.transport as any);
    this.connected = true;
    log.info({ serverUrl: this.options.serverUrl }, 'MCP client connected');
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.client) return;
    await this.client.close();
    this.connected = false;
    log.info('MCP client disconnected');
  }

  /**
   * Call a remote MCP tool.
   */
  async callTool(
    toolName: string,
    input: JsonObject,
    _context: ToolContext,
  ): Promise<ToolResult> {
    if (!this.client || !this.connected) {
      return {
        success: false,
        data: null,
        error: 'MCP client not connected',
        errorCode: ToolErrorCode.WORKER_UNAVAILABLE,
      };
    }

    try {
      const response = await this.client.callTool({
        name: toolName,
        arguments: input as Record<string, unknown>,
      });

      // Parse the text content from the MCP response
      // Cast to access content array safely across SDK version differences
      const responseAny = response as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      const contentArray = responseAny.content ?? [];
      if (contentArray.length > 0) {
        const firstContent = contentArray[0];
        if (firstContent && firstContent.type === 'text' && firstContent.text !== undefined) {
          try {
            return JSON.parse(firstContent.text) as ToolResult;
          } catch {
            return {
              success: true,
              data: { text: firstContent.text },
            };
          }
        }
      }

      return {
        success: !responseAny.isError,
        data: { content: JSON.stringify(responseAny.content) } as JsonSerializable,
        error: responseAny.isError ? 'Tool returned error' : undefined,
        errorCode: responseAny.isError ? ToolErrorCode.UNKNOWN : undefined,
      };
    } catch (err) {
      log.error({ err, toolName }, 'MCP tool call failed');
      return {
        success: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
        errorCode: ToolErrorCode.UNKNOWN,
      };
    }
  }

  /**
   * List available tools on the remote MCP server.
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    if (!this.client || !this.connected) return [];
    try {
      const response = await this.client.listTools();
      return response.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
      }));
    } catch (err) {
      log.error({ err }, 'Failed to list MCP tools');
      return [];
    }
  }

  /**
   * List available tools on the remote MCP server, preserving the inputSchema.
   */
  async listToolsWithSchema(): Promise<RemoteToolSchema[]> {
    if (!this.client || !this.connected) {
      log.debug({ serverUrl: this.options.serverUrl }, 'listToolsWithSchema called on disconnected client');
      return [];
    }
    try {
      const response = await this.client.listTools();
      return response.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
    } catch (err) {
      log.warn({ err, serverUrl: this.options.serverUrl }, 'Failed to list MCP tools with schema');
      return [];
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
