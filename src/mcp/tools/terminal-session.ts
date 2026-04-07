/**
 * src/mcp/tools/terminal-session.ts
 * MCP tool for terminal session management.
 */

import { z } from 'zod';
import { BaseTool } from './base.js';
import type { ToolResult, ToolContext, JsonObject } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import { TerminalErrorCode } from '../../terminal/types.js';
import { TerminalSessionManager } from '../../terminal/manager.js';
import { loadAllSkills } from '../../terminal/loader.js';
import { getConfig } from '../../config/index.js';

const TerminalSessionInputSchema = z.object({
  action: z.enum(['start', 'input', 'output', 'terminate', 'list']),
  skillName: z.string().optional(),
  args: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  input: z.string().optional(),
  timeout: z.number().optional(),
});

type TerminalSessionInput = z.infer<typeof TerminalSessionInputSchema>;

/**
 * Terminal session MCP tool.
 */
export class TerminalSessionTool extends BaseTool<TerminalSessionInput> {
  private manager: TerminalSessionManager | null = null;

  readonly name = 'terminal_session';
  readonly description = 'Manage terminal sessions for executing CLI tools via skill definitions. Use "list" to see available skills, "start" to launch a tool, "input" to send data, "output" to read results, "terminate" to stop a session.';

  readonly inputSchema = TerminalSessionInputSchema;

  /**
   * Initialize the terminal manager.
   */
  async initialize(): Promise<void> {
    const config = getConfig();
    const skills = await loadAllSkills(config.terminal.skillsPath);

    this.manager = new TerminalSessionManager(
      {
        skillsPath: config.terminal.skillsPath,
        commandAllowlist: config.terminal.commandAllowlist,
        cwdAllowlist: config.terminal.cwdAllowlist,
        envBlocklist: config.terminal.envBlocklist,
        defaultTimeout: config.terminal.defaultTimeout,
        maxConcurrentSessions: config.terminal.maxConcurrentSessions,
      },
      skills
    );

    this.log.info({ skills: skills.size }, 'Terminal session manager initialized');
  }

  /**
   * Get the manager instance.
   */
  getManager(): TerminalSessionManager {
    if (!this.manager) {
      throw new Error('Terminal session manager not initialized');
    }
    return this.manager;
  }

  /**
   * Run the tool.
   */
  protected async run(input: TerminalSessionInput, context: ToolContext): Promise<ToolResult> {
    const manager = this.getManager();

    try {
      switch (input.action) {
        case 'start':
          return await this.handleStart(input, manager);
        case 'input':
          return this.handleInput(input, manager);
        case 'output':
          return await this.handleOutput(input, manager);
        case 'terminate':
          return this.handleTerminate(input, manager);
        case 'list':
          return this.handleList(manager);
        default:
          return this.errorResult('Unknown action', ToolErrorCode.INVALID_INPUT);
      }
    } catch (err) {
      const error = err as { code?: TerminalErrorCode; message?: string };

      if (error.code) {
        return this.errorResult(error.message ?? 'Unknown error', this.mapErrorCode(error.code));
      }

      return this.errorResult((err as Error).message, ToolErrorCode.UNKNOWN);
    }
  }

  /**
   * Handle start action.
   */
  private async handleStart(input: TerminalSessionInput, manager: TerminalSessionManager): Promise<ToolResult> {
    if (!input.skillName) {
      return this.errorResult('skillName is required for start action', ToolErrorCode.INVALID_INPUT);
    }

    const result = await manager.startSession(
      input.skillName,
      input.args,
      input.cwd,
      input.timeout
    );

    const output = {
      action: 'start',
      success: true,
      sessionId: result.sessionId,
      output: {
        sessionId: result.sessionId,
        stdout: result.output.stdout,
        stderr: result.output.stderr,
        exitCode: result.output.exitCode,
        timedOut: result.output.timedOut,
      },
    };

    return {
      success: true,
      data: output as JsonObject,
      summary: `Session ${result.sessionId} started and completed`,
    };
  }

  /**
   * Handle input action.
   */
  private handleInput(input: TerminalSessionInput, manager: TerminalSessionManager): ToolResult {
    if (!input.sessionId) {
      return this.errorResult('sessionId is required for input action', ToolErrorCode.INVALID_INPUT);
    }

    if (!input.input) {
      return this.errorResult('input is required for input action', ToolErrorCode.INVALID_INPUT);
    }

const success = manager.input(input.sessionId, input.input);

    const output = {
      action: 'input',
      success,
      sessionId: input.sessionId,
    };

    return {
      success,
      data: output as JsonObject,
      summary: success ? 'Input sent' : 'Failed to send input',
    };
  }

  /**
   * Handle output action.
   */
  private async handleOutput(input: TerminalSessionInput, manager: TerminalSessionManager): Promise<ToolResult> {
    if (!input.sessionId) {
      return this.errorResult('sessionId is required for output action', ToolErrorCode.INVALID_INPUT);
    }

    const output = await manager.output(input.sessionId);

    const result = {
      action: 'output',
      success: true,
      sessionId: input.sessionId,
      output,
    };

    return {
      success: true,
      data: result as JsonObject,
      summary: `Retrieved output (${output.stdout.length} bytes stdout, ${output.stderr.length} bytes stderr)`,
    };
  }

  /**
   * Handle terminate action.
   */
  private handleTerminate(input: TerminalSessionInput, manager: TerminalSessionManager): ToolResult {
    if (!input.sessionId) {
      return this.errorResult('sessionId is required for terminate action', ToolErrorCode.INVALID_INPUT);
    }

    const success = manager.terminate(input.sessionId);

    const output = {
      action: 'terminate',
      success,
      sessionId: input.sessionId,
    };

    return {
      success,
      data: output as JsonObject,
      summary: success ? 'Session terminated' : 'Failed to terminate session',
    };
  }

  /**
   * Handle list action.
   */
  private handleList(manager: TerminalSessionManager): ToolResult {
    const sessions = manager.listSessions();

    const output = {
      action: 'list',
      success: true,
      sessions,
    };

    return {
      success: true,
      data: output as JsonObject,
      summary: `Listed ${sessions.length} session(s)`,
    };
  }

  /**
   * Map terminal error codes to tool error codes.
   */
  private mapErrorCode(code: TerminalErrorCode): ToolErrorCode {
    switch (code) {
      case TerminalErrorCode.SKILL_NOT_FOUND:
        return ToolErrorCode.NOT_FOUND;
      case TerminalErrorCode.COMMAND_NOT_ALLOWED:
      case TerminalErrorCode.CWD_NOT_ALLOWED:
      case TerminalErrorCode.PATH_ESCAPE_DETECTED:
        return ToolErrorCode.PERMISSION_DENIED;
      case TerminalErrorCode.PROCESS_CRASHED:
        return ToolErrorCode.UNKNOWN;
      case TerminalErrorCode.SESSION_TIMEOUT:
        return ToolErrorCode.TIMEOUT;
      case TerminalErrorCode.INVALID_ARGS:
        return ToolErrorCode.INVALID_INPUT;
      case TerminalErrorCode.SESSION_NOT_FOUND:
        return ToolErrorCode.NOT_FOUND;
      case TerminalErrorCode.MAX_SESSIONS_REACHED:
        return ToolErrorCode.RATE_LIMITED;
      default:
        return ToolErrorCode.UNKNOWN;
    }
  }

  /**
   * Create an error result.
   */
  private errorResult(message: string, errorCode: ToolErrorCode): ToolResult {
    return {
      success: false,
      data: null,
      error: message,
      errorCode,
    };
  }

  /**
   * Shutdown the manager.
   */
  async shutdown(): Promise<void> {
    if (this.manager) {
      await this.manager.shutdown();
      this.manager = null;
    }
  }
}