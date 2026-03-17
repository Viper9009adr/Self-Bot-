/**
 * src/mcp/server.ts
 * MCP SDK HTTP server using WebStandardStreamableHTTPServerTransport (Bun-compatible).
 * Uses Web Standard Request/Response APIs — works with Bun.serve() natively.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { MCPToolRegistry } from './registry.js';
import type { ToolContext } from '../types/tool.js';
import { childLogger } from '../utils/logger.js';
import { nanoid } from 'nanoid';

const log = childLogger({ module: 'mcp:server' });

export interface MCPServerOptions {
  port: number;
  host: string;
  registry: MCPToolRegistry;
}

export class MCPServer {
  private server: McpServer | null = null;
  private transport: WebStandardStreamableHTTPServerTransport | null = null;
  private bunServer: ReturnType<typeof Bun.serve> | null = null;
  private readonly options: MCPServerOptions;

  constructor(options: MCPServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const { port, host, registry } = this.options;

    this.server = new McpServer({
      name: 'self-bot',
      version: '0.1.0',
    });

    // Register all tools from the registry into the MCP server
    for (const tool of registry.listAll()) {
      this.server.tool(
        tool.name,
        tool.description,
        // Convert Zod schema to object shape for MCP SDK
        tool.inputSchema instanceof z.ZodObject
          ? (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape
          : {},
        async (args: Record<string, unknown>) => {
          const context: ToolContext = {
            userId: 'mcp-client',
            taskId: `mcp-${nanoid(8)}`,
            conversationId: 'mcp',
          };
          const result = await tool.execute(args as never, context);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result),
              },
            ],
            isError: !result.success,
          };
        },
      );
    }

    // Create WebStandard transport — uses Web Standard Request/Response (Bun-native)
    this.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => nanoid(),
    });

    await this.server.connect(this.transport);

    // Bun HTTP server to handle MCP requests
    const transport = this.transport;
    this.bunServer = Bun.serve({
      port,
      hostname: host,
      async fetch(req: Request, _server: ReturnType<typeof Bun.serve>) {
        const url = new URL(req.url);

        // Health endpoint
        if (url.pathname === '/health') {
          return new Response(JSON.stringify({ status: 'ok', tools: registry.listNames() }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // MCP endpoint — delegate to WebStandardStreamableHTTPServerTransport
        if (url.pathname === '/mcp') {
          return transport.handleRequest(req);
        }

        return new Response('Not Found', { status: 404 });
      },
    });

    log.info({ port, host, toolCount: registry.size }, 'MCP server started');
  }

  async stop(): Promise<void> {
    if (this.bunServer) {
      this.bunServer.stop();
      this.bunServer = null;
    }
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    log.info('MCP server stopped');
  }
}
