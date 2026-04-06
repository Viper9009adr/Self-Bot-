/**
 * tests/unit/mcp/check-pending-tasks.test.ts
 * Unit tests for the check_pending_tasks tool.
 */
import { describe, it, expect } from 'bun:test';
import { CheckPendingTasksTool } from '../../../src/mcp/tools/check-pending-tasks.js';
import { SessionManager } from '../../../src/session/manager.js';
import { InMemorySessionStore } from '../../../src/session/store.js';
import { TaskQueue } from '../../../src/queue/task-queue.js';
import type { ToolContext } from '../../../src/types/tool.js';

function makeQueue(): TaskQueue {
  const config = {
    queue: { concurrency: 2, perUserConcurrency: 1 },
  } as unknown as import('../../../src/config/index.js').Config;
  return new TaskQueue(config);
}

const context: ToolContext = {
  userId: 'user-a',
  taskId: 'task-test',
  conversationId: 'conv-test',
};

describe('CheckPendingTasksTool', () => {
  it('returns pulse data for the current user by default', async () => {
    const sessionManager = new SessionManager({ store: new InMemorySessionStore(3600) });
    const taskQueue = makeQueue();
    const tool = new CheckPendingTasksTool(sessionManager, taskQueue);

    await sessionManager.addActiveTask('user-a', 'task-1');

    const result = await tool.execute({ includeAllUsers: false }, context);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const users = data['users'] as Record<string, { activeTaskIds: string[]; concurrentTaskCount: number }>;
    expect(data['scope']).toBe('single_user');
    expect(users['user-a']?.activeTaskIds).toContain('task-1');
    expect(users['user-a']?.concurrentTaskCount).toBe(1);
    expect(data['queue']).toBeDefined();

    taskQueue.clear();
    await sessionManager.close();
  });

  it('can return pulse data for all users', async () => {
    const sessionManager = new SessionManager({ store: new InMemorySessionStore(3600) });
    const taskQueue = makeQueue();
    const tool = new CheckPendingTasksTool(sessionManager, taskQueue);

    await sessionManager.addActiveTask('user-a', 'task-a');
    await sessionManager.addActiveTask('user-b', 'task-b');
    await sessionManager.removeActiveTask('user-b', 'task-b');

    const result = await tool.execute({ includeAllUsers: true }, context);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const users = data['users'] as Record<string, { activeTaskIds: string[]; concurrentTaskCount: number }>;
    expect(data['scope']).toBe('all_users');
    expect(users['user-a']?.concurrentTaskCount).toBe(1);
    expect(users['user-b']?.concurrentTaskCount).toBe(0);
    expect(data['usersWithPendingTasks']).toBe(1);

    taskQueue.clear();
    await sessionManager.close();
  });
});
