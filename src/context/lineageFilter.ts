/**
 * src/context/lineageFilter.ts
 * Shared lineage filter builder and post-retrieval guard.
 */

export interface LineageBoundary {
  tenantId: string;
  userId: string;
  conversationId: string;
  sessionId: string;
  taskId: string;
}

/**
 * Record shape that can be checked against a full lineage boundary.
 */
export interface LineageScopedRecord {
  tenantId?: string | undefined;
  userId?: string | undefined;
  conversationId?: string | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
}

/**
 * Meridian lineage filter payload using snake_case field names.
 */
export interface MeridianLineageFilter {
  [key: string]: string;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  session_id: string;
  task_id: string;
}

/**
 * Convert internal lineage identifiers to Meridian filter format.
 */
export function buildLineageFilter(boundary: LineageBoundary): MeridianLineageFilter {
  return {
    tenant_id: boundary.tenantId,
    user_id: boundary.userId,
    conversation_id: boundary.conversationId,
    session_id: boundary.sessionId,
    task_id: boundary.taskId,
  };
}

/**
 * Build a predicate that accepts only exact lineage matches.
 */
export function buildLineagePredicate(boundary: LineageBoundary): (record: LineageScopedRecord) => boolean {
  return (record: LineageScopedRecord): boolean => {
    return record.tenantId === boundary.tenantId
      && record.userId === boundary.userId
      && record.conversationId === boundary.conversationId
      && record.sessionId === boundary.sessionId
      && record.taskId === boundary.taskId;
  };
}

/**
 * Fail-closed post-filter that removes out-of-lineage records.
 */
export function enforceLineageGuard<T extends LineageScopedRecord>(
  records: T[],
  boundary: LineageBoundary,
): T[] {
  const isSameLineage = buildLineagePredicate(boundary);
  return records.filter((record) => isSameLineage(record));
}
