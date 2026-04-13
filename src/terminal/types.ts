/**
 * src/terminal/types.ts
 * TypeScript interfaces for the Terminal Skills feature.
 */

import type { JsonObject } from '../types/tool.js';

// ─── Skill Definition ────────────────────────────────────────────────────────

/** Parameter definition for a skill argument */
export interface SkillArgument {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default: string | undefined;
}

/** Complete skill definition parsed from YAML frontmatter */
export interface SkillDefinition {
  /** Unique skill name (matches filename without .md) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Command to execute */
  command: string;
  /** Default arguments to pass to the command */
  args: string[];
  /** Argument schema for validation */
  arguments: SkillArgument[];
  /** Default working directory */
  cwd: string;
  /** Environment variables to set */
  env: Record<string, string>;
  /** Timeout in milliseconds */
  timeout: number;
  requiresShellMode?: boolean;
  shellQuoting?: ShellQuotingRules;
}

// ─── Session Management ────────────────────────────────────────────────────────

/** Terminal session state */
export interface TerminalSession {
  /** Unique session ID */
  id: string;
  /** Skill name this session is running */
  skillName: string;
  /** Spawned process */
  process: ReturnType<typeof import('child_process')['spawn']>;
  /** Session start timestamp */
  startedAt: number;
  /** Last activity timestamp */
  lastActivityAt: number;
  /** Whether the session has ended */
  ended: boolean;
  /** Exit code if ended */
  exitCode: number | null;
  /** Buffered stdout data */
  stdout: string[];
  /** Buffered stderr data */
  stderr: string[];
  /** Resolver for pending output promise */
  outputResolver?: (output: TerminalOutput) => void;
}

/** Output from a terminal session */
export interface TerminalOutput {
  sessionId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  [key: string]: unknown;
}

// ─── Error Codes ────────────────────────────────────────────────────────────────

/** Terminal-specific error codes */
export enum TerminalErrorCode {
  SKILL_NOT_FOUND = 'SKILL_NOT_FOUND',
  COMMAND_NOT_ALLOWED = 'COMMAND_NOT_ALLOWED',
  PROCESS_CRASHED = 'PROCESS_CRASHED',
  SESSION_TIMEOUT = 'SESSION_TIMEOUT',
  INVALID_ARGS = 'INVALID_ARGS',
  CWD_NOT_ALLOWED = 'CWD_NOT_ALLOWED',
  PATH_ESCAPE_DETECTED = 'PATH_ESCAPE_DETECTED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  MAX_SESSIONS_REACHED = 'MAX_SESSIONS_REACHED',
}

// ─── Tool Input/Output ────────────────────────────────────────────────────────

/** Input schema for terminal_session tool */
export type TerminalSessionInput = {
  action: 'start' | 'input' | 'output' | 'terminate' | 'list';
  skillName?: string;
  args?: Record<string, string>;
  cwd?: string;
  sessionId?: string;
  input?: string;
  timeout?: number;
};

/** Output schema for terminal_session tool */
export type TerminalSessionOutput = {
  action: string;
  success: boolean;
  sessionId?: string;
  sessions?: Array<{
    id: string;
    skillName: string;
    startedAt: number;
    ended: boolean;
  }>;
  output?: TerminalOutput;
  error?: string;
  errorCode?: TerminalErrorCode;
};

// ─── Configuration ────────────────────────────────────────────────────────────

/** Terminal configuration from config */
export interface TerminalConfig {
  skillsPath: string;
  commandAllowlist: string[];
  cwdAllowlist: string[];
  envBlocklist: string[];
  defaultTimeout: number;
  maxConcurrentSessions: number;
}

// ─── Validation Result ────────────────────────────────────────────────────────

/** Result of skill validation */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Rule for shell quoting behavior at a specific argument position.
 * 
 * Specifies whether an argument at a given position should be shell-quoted when
 * executing a command. Flags (arguments starting with '-') are always unquoted
 * regardless of rules. Position indices support both positive (0, 1, 2...) and
 * negative (-1, -2...) for counting from the end of the argument array.
 */
export interface ShellQuotingRule {
  /** 
   * Argument position (0-based). Negative values count from end of array.
   * @example 0 - First argument
   * @example 1 - Second argument
   * @example -1 - Last argument
   * @example -2 - Second-to-last argument
   */
  position: number;
  /** 
   * If false, argument will not be shell-quoted even if it contains spaces.
   * If true (or unspecified), argument will be quoted if not a flag.
   */
  quote: boolean;
}

/**
 * Container for shell quoting rules for a skill command.
 * 
 * Defines how arguments should be quoted when executing a shell command.
 * This is particularly useful for tools like OpenCode that require specific
 * arguments (like subcommands) to remain unquoted while others (like prompts)
 * must be quoted to preserve spaces and special characters.
 */
export interface ShellQuotingRules {
  /** Array of position-based quoting rules. Load-time validation ensures no duplicate positions. */
  argRules: ShellQuotingRule[];
}

/** Loaded skill with metadata */
export interface LoadedSkill {
  definition: SkillDefinition;
  filePath: string;
}