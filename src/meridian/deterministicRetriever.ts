/**
 * src/meridian/deterministicRetriever.ts
 * Meridian deterministic retrieval adapter.
 */
import type { MCPClient } from '../mcp/client.js';
import type { ToolContext } from '../types/tool.js';
import type { MemoryRecord } from '../memory/retrievalRouter.js';
import type { MeridianLineageFilter } from '../context/lineageFilter.js';

const MERIDIAN_CTX: ToolContext = {
  userId: 'system',
  taskId: 'deterministic-retriever',
  conversationId: 'deterministic-retriever',
};

interface MeridianDeterministicHit {
  id?: string;
  content?: string;
  tenant_id?: string;
  user_id?: string;
  conversation_id?: string;
  session_id?: string;
  task_id?: string;
  timestamp?: number | string;
}

export class MeridianDeterministicRetriever {
  /**
   * Create a deterministic retriever adapter over the Meridian MCP client.
   */
  constructor(private readonly client: MCPClient) {}

  /**
   * Fetch deterministic hits from Meridian and map them into memory records.
   */
  async retrieve(query: { text: string; lineage: MeridianLineageFilter }): Promise<MemoryRecord[]> {
    const result = await this.client.callTool(
      'fetch_context',
      {
        mode: 'full',
        query: query.text,
        lineage: query.lineage,
      },
      MERIDIAN_CTX,
    );

    if (!result.success) {
      return [];
    }

    const hits = this.normalizeHits(result.data);
    const filtered = this.applyLexicalFilter(hits, query.text);
    return filtered.map((hit, idx) => this.toMemoryRecord(hit, idx));
  }

  private normalizeHits(data: unknown): MeridianDeterministicHit[] {
    if (Array.isArray(data)) {
      return data as MeridianDeterministicHit[];
    }
    if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown[] }).items)) {
      return (data as { items: MeridianDeterministicHit[] }).items;
    }
    return [];
  }

  private applyLexicalFilter(hits: MeridianDeterministicHit[], text: string): MeridianDeterministicHit[] {
    const tokens = this.tokenize(text);
    if (tokens.length === 0) {
      return hits;
    }

    return hits.filter((hit) => {
      const haystack = (hit.content ?? '').toLowerCase();
      return tokens.some((token) => haystack.includes(token));
    });
  }

  private tokenize(text: string): string[] {
    const parts = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    const unique = new Set(parts);
    return Array.from(unique).slice(0, 8);
  }

  private toMemoryRecord(hit: MeridianDeterministicHit, idx: number): MemoryRecord {
    return {
      id: hit.id ?? `det_${idx}`,
      content: hit.content ?? '',
      tenantId: hit.tenant_id,
      userId: hit.user_id,
      conversationId: hit.conversation_id,
      sessionId: hit.session_id,
      taskId: hit.task_id,
      timestamp: this.toTimestamp(hit.timestamp),
    };
  }

  private toTimestamp(value: number | string | undefined): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }
}
