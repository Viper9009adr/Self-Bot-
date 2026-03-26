/**
 * src/memory/retrievalRouter.ts
 * Deterministic/semantic retrieval routing for context injection.
 */
import { buildLineageFilter, enforceLineageGuard, type LineageBoundary, type LineageScopedRecord } from '../context/lineageFilter.js';

export type RetrievalMode = 'det' | 'sem' | 'fallback';
export type RecallIntent = 'explicit_memory' | 'vague_recall' | 'none';

export interface MemoryRetrievalQuery {
  text: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  sessionId: string;
  taskId: string;
}

export interface MemoryRecord extends LineageScopedRecord {
  id: string;
  content: string;
  timestamp: number;
}

export interface RetrievalResult {
  mode: RetrievalMode;
  records: MemoryRecord[];
}

export interface DeterministicRetriever {
  /**
   * Run deterministic retrieval constrained by the provided lineage filter.
   */
  retrieve(query: { text: string; lineage: ReturnType<typeof buildLineageFilter> }): Promise<MemoryRecord[]>;
}

export interface SemanticRetriever {
  /**
   * Run semantic retrieval constrained by the provided lineage filter.
   */
  retrieve(query: { text: string; lineage: ReturnType<typeof buildLineageFilter> }): Promise<MemoryRecord[]>;
}

const EXPLICIT_MEMORY_PATTERNS: readonly RegExp[] = [
  /\bremember\b/i,
  /\bwhat did (i|we) (say|ask|tell)\b/i,
  /\brecall\b/i,
  /\bmemory\b/i,
  /\bprevious\b/i,
];

const VAGUE_RECALL_PATTERNS: readonly RegExp[] = [
  /\bthat thing\b/i,
  /\bearlier\b/i,
  /\bbefore\b/i,
  /\bas mentioned\b/i,
  /\bthe one\b/i,
  /\bwe discussed\b/i,
];

export class RetrievalRouter {
  /**
   * Create a router with deterministic and semantic retrievers.
   */
  constructor(
    private readonly deterministicRetriever: DeterministicRetriever,
    private readonly semanticRetriever: SemanticRetriever,
  ) {}

  /**
   * Route retrieval based on recall intent with lineage enforcement.
   */
  async retrieve(query: MemoryRetrievalQuery): Promise<RetrievalResult> {
    const boundary: LineageBoundary = {
      tenantId: query.tenantId,
      userId: query.userId,
      conversationId: query.conversationId,
      sessionId: query.sessionId,
      taskId: query.taskId,
    };
    const lineage = buildLineageFilter(boundary);
    const intent = detectRecallIntent(query.text);

    if (intent === 'explicit_memory') {
      const records = await this.deterministicRetriever.retrieve({ text: query.text, lineage });
      const guarded = enforceLineageGuard(records, boundary);
      const ordered = guarded.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      return { mode: 'det', records: ordered };
    }

    if (intent === 'vague_recall') {
      const semRecords = await this.semanticRetriever.retrieve({ text: query.text, lineage });
      const semGuarded = enforceLineageGuard(semRecords, boundary);
      if (semGuarded.length > 0) {
        return { mode: 'sem', records: semGuarded };
      }

      const detRecords = await this.deterministicRetriever.retrieve({ text: query.text, lineage });
      const detGuarded = enforceLineageGuard(detRecords, boundary);
      const ordered = detGuarded.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      return { mode: 'fallback', records: ordered };
    }

    return { mode: 'det', records: [] };
  }
}

/**
 * Classify user text into explicit memory, vague recall, or none.
 */
export function detectRecallIntent(text: string): RecallIntent {
  if (EXPLICIT_MEMORY_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'explicit_memory';
  }
  if (VAGUE_RECALL_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'vague_recall';
  }
  return 'none';
}
