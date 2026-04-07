/**
 * src/mcp/client.ts
 * MCP client wrapper used by AgentCore to call remote MCP tools.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ToolResult, ToolContext, JsonObject, JsonSerializable } from '../types/tool.js';
import { ToolErrorCode } from '../types/tool.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'mcp:client' });

/** Configuration passed to {@link MCPClient} at construction time. */
export interface MCPClientOptions {
  /**
   * Base URL of the remote MCP server.
   * - Streamable HTTP servers: pass the base URL (e.g. `https://mcp.example.com`); client appends `/mcp` automatically.
   * - SSE servers: pass the full SSE endpoint URL (e.g. `http://localhost:8080/sse`); auto-detected by `/sse` pathname suffix.
   * - If your Streamable HTTP server URL path ends in `/sse`, pass `transport: 'streamable-http'` explicitly to override auto-detection.
   */
  serverUrl: string;
  /**
   * Transport protocol to use. If absent, auto-detected from `serverUrl` pathname:
   * a pathname ending in `/sse` selects `'sse'`; all other paths select `'streamable-http'`.
   */
  transport?: 'streamable-http' | 'sse';
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
 * HTTP or SSE connection (auto-detected from URL) to a remote MCP server.
 *
 * Typical lifecycle:
 * 1. `new MCPClient({ serverUrl })` — construct (no I/O yet)
 * 2. `await client.connect()` — establish the transport and perform handshake
 * 3. `await client.callTool(...)` / `await client.listToolsWithSchema()` — use
 * 4. `await client.disconnect()` — close the transport gracefully
 *
 * @remarks
 * `SSEClientTransport` is intentionally used for SSE-based servers (such as
 * Meridian's FastMCP backend) despite being marked deprecated in the MCP SDK.
 * The deprecation signals that new servers should prefer Streamable HTTP, but
 * not all existing servers have migrated. Until Meridian and similar servers
 * expose a Streamable HTTP endpoint, `SSEClientTransport` remains the correct
 * transport for any `serverUrl` whose pathname ends in `/sse`.
 */
export class MCPClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private connected = false;
  private readonly options: MCPClientOptions;
  /** Reconnection configuration */
  private readonly maxRetries = 1;
  private readonly baseDelayMs = 100;

  private _toToolResultFromResponse(
    toolName: string,
    responseAny: {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    },
  ): ToolResult {
    const contentArray = responseAny.content ?? [];
    if (contentArray.length > 0) {
      const firstContent = contentArray[0];
      if (firstContent && firstContent.type === 'text' && firstContent.text !== undefined) {
        try {
          const parsed = JSON.parse(firstContent.text) as Record<string, unknown>;
          // If the parsed value already has a boolean `success` field it is a
          // ToolResult-shaped payload (non-Meridian tools or future versions).
          // Otherwise it is a raw Meridian response dict/array — wrap it.
          if (typeof (parsed as { success?: unknown }).success === 'boolean') {
            return parsed as unknown as ToolResult;
          }
          return { success: true, data: parsed as JsonSerializable };
        } catch {
          // fetch_context is expected to be JSON. A plain-text fallback here is
          // deterministic parse failure and must not be treated as "not found".
          if (toolName === 'fetch_context') {
            return {
              success: false,
              data: null,
              error: 'Malformed fetch_context payload (non-JSON text content)',
              errorCode: ToolErrorCode.PARSE_ERROR,
            };
          }
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
  }

  constructor(options: MCPClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const serverUrl = new URL(this.options.serverUrl);
    const useSSE =
      this.options.transport === 'sse' ||
      (this.options.transport === undefined && serverUrl.pathname.endsWith('/sse'));
    this.transport = useSSE
      ? new SSEClientTransport(serverUrl)
      : new StreamableHTTPClientTransport(new URL('/mcp', serverUrl));

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
    log.info({ serverUrl: this.options.serverUrl, transport: useSSE ? 'sse' : 'streamable-http' }, 'MCP client connected');
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.client) return;
    await this.client.close();
    this.connected = false;
    log.info('MCP client disconnected');
  }

  /**
   * Attempt to reconnect to the MCP server.
   * Uses exponential backoff with a single retry.
   */
  private async _reconnect(): Promise<boolean> {
    const delay = this.baseDelayMs * Math.pow(2, 0); // exponential backoff, single retry
    log.info({ delay }, 'MCP client attempting reconnection');

    // Small delay before retry
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.disconnect();
      await this.connect();
      return true;
    } catch (err) {
      log.warn({ err }, 'MCP client reconnection failed');
      this.connected = false;
      return false;
    }
  }

  /**
   * Call a remote MCP tool.
   * Includes reconnection logic: if not connected, attempts to reconnect once before failing.
   */
  async callTool(
    toolName: string,
    input: JsonObject,
    _context: ToolContext,
  ): Promise<ToolResult> {
    // Check if connected - if not, attempt reconnection once
    if (!this.connected || !this.client) {
      log.debug({ toolName }, 'MCP client not connected, attempting reconnection');
      const reconnected = await this._reconnect();
      if (!reconnected) {
        return {
          success: false,
          data: null,
          error: 'MCP client not connected',
          errorCode: ToolErrorCode.WORKER_UNAVAILABLE,
        };
      }
    }

    // After reconnection or if already connected, client should be initialized
    const client = this.client;
    if (!client) {
      return {
        success: false,
        data: null,
        error: 'MCP client not initialized',
        errorCode: ToolErrorCode.WORKER_UNAVAILABLE,
      };
    }

    try {
      const response = await client.callTool({
        name: toolName,
        arguments: input as Record<string, unknown>,
      });

      // Parse the text content from the MCP response
      // Cast to access content array safely across SDK version differences
      const responseAny = response as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      return this._toToolResultFromResponse(toolName, responseAny);
    } catch (err) {
      // Mark as disconnected on connection error during tool call
      log.error({ err, toolName }, 'MCP tool call failed, marking as disconnected');
      this.connected = false;

      // Check if it's a connection error - attempt reconnection once
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('connect') ||
        errorMessage.includes('network') ||
        errorMessage.includes('socket');

      if (isConnectionError) {
        log.debug({ toolName }, 'Connection error during tool call, attempting reconnection');
        const reconnected = await this._reconnect();
        if (reconnected) {
          // Retry the tool call once after successful reconnection
          const retryClient = this.client;
          if (!retryClient) {
            return {
              success: false,
              data: null,
              error: 'MCP client not initialized after reconnection',
              errorCode: ToolErrorCode.WORKER_UNAVAILABLE,
            };
          }
          try {
            const response = await retryClient.callTool({
              name: toolName,
              arguments: input as Record<string, unknown>,
            });

            const responseAny = response as {
              content?: Array<{ type: string; text?: string }>;
              isError?: boolean;
            };
            return this._toToolResultFromResponse(toolName, responseAny);
          } catch (retryErr) {
            log.error({ err: retryErr, toolName }, 'MCP tool call retry failed');
            // Fall through to return error below
          }
        }
      }

      return {
        success: false,
        data: null,
        error: errorMessage,
        errorCode: ToolErrorCode.WORKER_UNAVAILABLE,
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
