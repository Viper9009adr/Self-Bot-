/**
 * src/meridian/semanticRetriever.ts
 * Meridian semantic retrieval adapter.
 */
import type { MCPClient } from '../mcp/client.js';
import type { ToolContext } from '../types/tool.js';
import type { MemoryRecord } from '../memory/retrievalRouter.js';
import type { MeridianLineageFilter } from '../context/lineageFilter.js';

const MERIDIAN_CTX: ToolContext = {
  userId: 'system',
  taskId: 'semantic-retriever',
  conversationId: 'semantic-retriever',
};

interface MeridianSemanticHit {
  id?: string;
  content?: string;
  tenant_id?: string;
  user_id?: string;
  conversation_id?: string;
  session_id?: string;
  task_id?: string;
  timestamp?: number;
}

export class MeridianSemanticRetriever {
  /**
   * Create a semantic retriever adapter over the Meridian MCP client.
   */
  constructor(private readonly client: MCPClient) {}

  /**
   * Fetch semantic hits from Meridian and map them into memory records.
   */
  async retrieve(query: { text: string; lineage: MeridianLineageFilter }): Promise<MemoryRecord[]> {
    const result = await this.client.callTool(
      'fetch_context',
      {
        mode: 'semantic',
        query: query.text,
        lineage: query.lineage,
      },
      MERIDIAN_CTX,
    );

    if (!result.success) {
      return [];
    }

    const hits = this.normalizeHits(result.data);
    return hits.map((hit, idx) => this.toMemoryRecord(hit, idx));
  }

  private normalizeHits(data: unknown): MeridianSemanticHit[] {
    if (Array.isArray(data)) {
      return data as MeridianSemanticHit[];
    }
    if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown[] }).items)) {
      return (data as { items: MeridianSemanticHit[] }).items;
    }
    return [];
  }

  private toMemoryRecord(hit: MeridianSemanticHit, idx: number): MemoryRecord {
    return {
      id: hit.id ?? `sem_${idx}`,
      content: hit.content ?? '',
      tenantId: hit.tenant_id,
      userId: hit.user_id,
      conversationId: hit.conversation_id,
      sessionId: hit.session_id,
      taskId: hit.task_id,
      timestamp: typeof hit.timestamp === 'number' ? hit.timestamp : 0,
    };
  }
}
