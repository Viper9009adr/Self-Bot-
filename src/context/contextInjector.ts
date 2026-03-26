/**
 * src/context/contextInjector.ts
 * Builds injected context from routed memory retrieval.
 */
import { enforceLineageGuard, type LineageBoundary } from './lineageFilter.js';
import type { MemoryRetrievalQuery, RetrievalMode, RetrievalRouter } from '../memory/retrievalRouter.js';

export interface InjectedContext {
  retrievalMode: RetrievalMode;
  snippets: string[];
}

/**
 * Builds lineage-scoped snippets for prompt/context injection.
 */
export class ContextInjector {
  /**
   * Create a context injector backed by a retrieval router.
   */
  constructor(private readonly retrievalRouter: RetrievalRouter) {}

  /**
   * Retrieve records for a query and return lineage-guarded text snippets.
   */
  async inject(query: MemoryRetrievalQuery): Promise<InjectedContext> {
    const boundary: LineageBoundary = {
      tenantId: query.tenantId,
      userId: query.userId,
      conversationId: query.conversationId,
      sessionId: query.sessionId,
      taskId: query.taskId,
    };

    const routed = await this.retrievalRouter.retrieve(query);
    const guarded = enforceLineageGuard(routed.records, boundary);

    return {
      retrievalMode: routed.mode,
      snippets: guarded.map((record) => record.content),
    };
  }
}
