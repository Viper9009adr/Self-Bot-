/**
 * src/mcp/tools/check-pending-tasks.ts
 * MCP tool: provide a pulse-style snapshot of pending tasks.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { SessionManager } from '../../session/manager.js';
import type { TaskQueue } from '../../queue/task-queue.js';
import type { ToolContext, ToolResult } from '../../types/tool.js';

const inputSchema = z.object({
  userId: z.string().optional().describe('Optional user ID to inspect. Defaults to the current user.'),
  includeAllUsers: z.boolean().default(false).describe('When true, include pending task snapshots for all active users.'),
});

type Input = z.infer<typeof inputSchema>;

export class CheckPendingTasksTool extends BaseTool<Input> {
  readonly name = 'check_pending_tasks';
  readonly description =
    'Check pending tasks like a pulse. Returns active task IDs and queue metrics for the current user or all users.';
  readonly inputSchema = inputSchema;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly taskQueue: TaskQueue,
  ) {
    super();
  }

  protected async run(input: Input, context: ToolContext): Promise<ToolResult> {
    const requestedUserId = input.userId?.trim() || context.userId;
    const includeAllUsers = input.includeAllUsers === true;
    const userIds = includeAllUsers
      ? await this.sessionManager.listUsers()
      : [requestedUserId];

    const users: Record<string, { activeTaskIds: string[]; concurrentTaskCount: number }> = {};

    for (const userId of userIds) {
      const session = await this.sessionManager.get(userId);
      users[userId] = {
        activeTaskIds: session?.activeTaskIds ?? [],
        concurrentTaskCount: session?.concurrentTaskCount ?? 0,
      };
    }

    const queueMetrics = this.taskQueue.getMetrics();
    const usersWithPendingTasks = Object.values(users).filter((u) => u.concurrentTaskCount > 0).length;

    return {
      success: true,
      data: {
        pulseAt: new Date().toISOString(),
        requestedBy: context.userId,
        ...(includeAllUsers ? { scope: 'all_users' } : { scope: 'single_user' }),
        queue: {
          size: queueMetrics.size,
          pending: queueMetrics.pending,
          concurrency: queueMetrics.concurrency,
        },
        users,
        usersWithPendingTasks,
      },
      summary: includeAllUsers
        ? `Pulse check complete: ${usersWithPendingTasks} users with pending tasks`
        : `Pulse check complete for ${requestedUserId}: ${users[requestedUserId]?.concurrentTaskCount ?? 0} pending tasks`,
    };
  }
}
