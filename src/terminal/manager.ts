/**
 * src/terminal/manager.ts
 * Terminal session manager - spawn, input, output, terminate.
 */

import { nanoid } from 'nanoid';
import type { ChildProcess } from 'node:child_process';
import { childLogger } from '../utils/logger.js';
import type {
  TerminalSession,
  TerminalOutput,
  TerminalConfig,
  SkillDefinition,
  LoadedSkill,
} from './types.js';
import { TerminalErrorCode } from './types.js';
import { executeSkill, sendInput, terminateProcess, isProcessRunning } from './executor.js';
import { validateSessionInput } from './validator.js';

const log = childLogger({ module: 'terminal:manager' });

/**
 * Terminal session manager.
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly config: TerminalConfig;
  private readonly skills: Map<string, LoadedSkill>;

  constructor(config: TerminalConfig, skills: Map<string, LoadedSkill>) {
    this.config = config;
    this.skills = skills;
  }

  /**
   * Start a new terminal session.
   */
  async startSession(
    skillName: string,
    userArgs?: Record<string, string>,
    customCwd?: string,
    customTimeout?: number
  ): Promise<{ sessionId: string; output: TerminalOutput }> {
    // Check max concurrent sessions
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error('Maximum concurrent sessions reached');
    }

    // Get skill
    const skill = this.skills.get(skillName);
    if (!skill) {
      throw {
        code: TerminalErrorCode.SKILL_NOT_FOUND,
        message: `Skill '${skillName}' not found`,
      };
    }

    // Validate inputs
    const validation = validateSessionInput(
      skill.definition,
      this.config,
      userArgs,
      customCwd
    );

    if (!validation.valid) {
      throw {
        code: TerminalErrorCode.INVALID_ARGS,
        message: validation.errors.join('; '),
      };
    }

    // Create session ID
    const sessionId = nanoid(8);

    log.info({ sessionId, skillName }, 'Starting terminal session');

    // Execute the skill
    const { process: proc, promise } = executeSkill(
      skill.definition,
      this.config,
      userArgs,
      customCwd,
      customTimeout
    );

    // Create session
    const session: TerminalSession = {
      id: sessionId,
      skillName,
      process: proc,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      ended: false,
      exitCode: null,
      stdout: [],
      stderr: [],
    };

    this.sessions.set(sessionId, session);

    // Wait for output
    let output: TerminalOutput;
    try {
      output = await promise;
      output.sessionId = sessionId;
    } catch (err) {
      session.ended = true;
      session.exitCode = -1;
      this.sessions.delete(sessionId);
      throw {
        code: TerminalErrorCode.PROCESS_CRASHED,
        message: (err as Error).message,
      };
    }

    // Update session state
    session.ended = true;
    session.exitCode = output.exitCode;
    session.stdout = output.stdout.split('\n').filter(line => line.length > 0);
    session.stderr = output.stderr.split('\n').filter(line => line.length > 0);

    // Clean up if process has ended
    if (output.timedOut) {
      this.sessions.delete(sessionId);
      throw {
        code: TerminalErrorCode.SESSION_TIMEOUT,
        message: 'Process timed out',
      };
    }

    return { sessionId, output };
  }

  /**
   * Send input to a running session.
   */
  input(sessionId: string, input: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw {
        code: TerminalErrorCode.SESSION_NOT_FOUND,
        message: `Session '${sessionId}' not found`,
      };
    }

    if (session.ended) {
      throw {
        code: TerminalErrorCode.PROCESS_CRASHED,
        message: 'Process has already ended',
      };
    }

    const success = sendInput(session.process, input);
    if (success) {
      session.lastActivityAt = Date.now();
    }

    return success;
  }

  /**
   * Get output from a session.
   */
  async output(sessionId: string): Promise<TerminalOutput> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw {
        code: TerminalErrorCode.SESSION_NOT_FOUND,
        message: `Session '${sessionId}' not found`,
      };
    }

    // If session has ended, return buffered output
    if (session.ended) {
      return {
        sessionId,
        stdout: session.stdout.join('\n'),
        stderr: session.stderr.join('\n'),
        exitCode: session.exitCode,
        timedOut: false,
      };
    }

    // For running sessions, we'd need to implement streaming
    // For now, return buffered output
    return {
      sessionId,
      stdout: session.stdout.join('\n'),
      stderr: session.stderr.join('\n'),
      exitCode: null,
      timedOut: false,
    };
  }

  /**
   * Terminate a session.
   */
  terminate(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw {
        code: TerminalErrorCode.SESSION_NOT_FOUND,
        message: `Session '${sessionId}' not found`,
      };
    }

    if (session.ended) {
      return true;
    }

    terminateProcess(session.process);
    session.ended = true;
    session.exitCode = -1;

    return true;
  }

  /**
   * List all active sessions.
   */
  listSessions(): Array<{
    id: string;
    skillName: string;
    startedAt: number;
    ended: boolean;
  }> {
    const result: Array<{
      id: string;
      skillName: string;
      startedAt: number;
      ended: boolean;
    }> = [];

    for (const [id, session] of this.sessions) {
      result.push({
        id,
        skillName: session.skillName,
        startedAt: session.startedAt,
        ended: session.ended,
      });
    }

    return result;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get the number of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Reload skills.
   */
  reloadSkills(skills: Map<string, LoadedSkill>): void {
    this.skills.clear();
    for (const [name, skill] of skills) {
      this.skills.set(name, skill);
    }
    log.info({ count: skills.size }, 'Skills reloaded');
  }

  /**
   * Clean up all sessions.
   */
  async shutdown(): Promise<void> {
    log.info({ count: this.sessions.size }, 'Shutting down terminal sessions');

    for (const [id, session] of this.sessions) {
      if (!session.ended) {
        terminateProcess(session.process);
        session.ended = true;
        session.exitCode = -1;
      }
    }

    this.sessions.clear();
  }
}