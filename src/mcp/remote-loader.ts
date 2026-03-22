/**
 * src/mcp/remote-loader.ts
 * RemoteMCPLoader discovers remote MCP servers from config, connects to each,
 * enumerates their tools, and registers RemoteToolWrapper instances into the
 * local MCPToolRegistry at startup.
 */
import pRetry from 'p-retry';
import { MCPClient } from './client.js';
import type { MCPToolRegistry } from './registry.js';
import { RemoteToolWrapper } from './tools/remote-tool.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'mcp:remote-loader' });

/** Regex that matches RFC-1918 private IP ranges and loopback. */
const PRIVATE_IP_RE =
  /^(?:127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|::1$|localhost)/i;

/**
 * Discovers remote MCP servers listed in `MCP_REMOTE_SERVERS`, connects to
 * each one with exponential-backoff retry, enumerates their tools, and
 * registers a {@link RemoteToolWrapper} for every tool into the local
 * {@link MCPToolRegistry}.
 *
 * Instantiate once at startup and call {@link load}. Call {@link dispose}
 * during graceful shutdown to disconnect all tracked clients.
 */
export class RemoteMCPLoader {
  private readonly registry: MCPToolRegistry;
  private readonly rawEnv: string | undefined;
  private readonly clients: MCPClient[] = [];

  /**
   * @param registry - The tool registry that remote tools will be registered into.
   * @param rawEnv   - Raw value of the `MCP_REMOTE_SERVERS` environment variable.
   *                   Pass `undefined` or an empty string to disable remote loading.
   */
  constructor(registry: MCPToolRegistry, rawEnv: string | undefined) {
    this.registry = registry;
    this.rawEnv = rawEnv;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Parse MCP_REMOTE_SERVERS, connect to each server, and register tools.
   * No-op when the env var is absent or empty.
   */
  async load(): Promise<void> {
    if (!this.rawEnv || this.rawEnv.trim() === '') return;

    const urls = this.parseEnv(this.rawEnv);
    if (urls.length === 0) return;

    for (const url of urls) {
      await this.loadServer(url);
    }
  }

  /**
   * Disconnect all tracked clients. Errors are logged, not thrown.
   */
  async dispose(): Promise<void> {
    if (this.clients.length === 0) return;

    const results = await Promise.allSettled(
      this.clients.map((c) => c.disconnect()),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        log.warn({ reason: result.reason }, 'Error disconnecting remote MCP client');
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Connect to a single MCP server and register its tools.
   * Sequence: validateUrl → connectWithRetry → track client → listToolsWithSchema → register.
   */
  private async loadServer(rawUrl: string): Promise<void> {
    const urlStr = this.validateUrl(rawUrl);
    if (!urlStr) return;

    const client = await this.connectWithRetry(urlStr);
    if (!client) return;

    // Track immediately so dispose() always cleans up live connections.
    this.clients.push(client);

    const schemas = await client.listToolsWithSchema();
    log.info({ serverUrl: urlStr, toolCount: schemas.length }, 'Remote MCP server connected');

    for (const schema of schemas) {
      if (this.registry.get(schema.name)) {
        log.warn(
          { toolName: schema.name, serverUrl: urlStr },
          'Skipping remote tool — name already registered',
        );
        continue;
      }
      const tool = new RemoteToolWrapper(client, schema);
      this.registry.register(tool);
      log.debug({ toolName: schema.name, serverUrl: urlStr }, 'Remote tool registered');
    }
  }

  /**
   * Parse the raw env value as JSON array first, then fall back to CSV.
   * Invalid entries are skipped with a warning.
   */
  private parseEnv(raw: string): string[] {
    const trimmed = raw.trim();

    // Try JSON array
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter((v): v is string => typeof v === 'string');
        }
      } catch {
        log.warn('MCP_REMOTE_SERVERS looks like JSON but failed to parse; falling back to CSV');
      }
    }

    // CSV fallback — validate each entry is a parseable URL
    return trimmed.split(',').reduce<string[]>((acc, entry) => {
      const url = entry.trim();
      if (!url) return acc;
      try {
        new URL(url); // throws if invalid
        acc.push(url);
      } catch {
        log.warn({ entry: url }, 'Skipping invalid MCP_REMOTE_SERVERS entry');
      }
      return acc;
    }, []);
  }

  /**
   * Validate that the URL uses http(s). Private IPs produce a warning but are allowed.
   * Returns the validated URL string, or null on hard failure.
   */
  private validateUrl(rawUrl: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      log.warn({ url: rawUrl }, 'Invalid URL in MCP_REMOTE_SERVERS — skipping');
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log.warn(
        { url: rawUrl, protocol: parsed.protocol },
        'MCP_REMOTE_SERVERS entry must use http(s) — skipping',
      );
      return null;
    }

    if (PRIVATE_IP_RE.test(parsed.hostname)) {
      log.warn(
        { url: rawUrl },
        'MCP_REMOTE_SERVERS entry points to a private/loopback address',
      );
    }

    return rawUrl;
  }

  /**
   * Connect to an MCP server with exponential-backoff retry (3 attempts).
   * Returns the connected MCPClient, or null if all attempts fail.
   */
  private async connectWithRetry(serverUrl: string): Promise<MCPClient | null> {
    try {
      return await pRetry(
        async () => {
          const client = new MCPClient({ serverUrl });
          await client.connect();
          return client;
        },
        {
          retries: 3,
          factor: 2,
          minTimeout: 500,
          onFailedAttempt: (error) => {
            log.warn(
              { serverUrl, attempt: error.attemptNumber, err: error.message },
              'Retrying MCP server connection',
            );
          },
        },
      );
    } catch (err) {
      log.error({ serverUrl, err }, 'Failed to connect to remote MCP server after retries');
      return null;
    }
  }
}
