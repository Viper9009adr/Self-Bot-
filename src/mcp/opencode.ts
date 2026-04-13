import type { JsonObject } from '../types/tool.js';
import type { LoadedSkill } from '../terminal/types.js';
import { runTerminalSessionGates, type SessionGateResult } from '../terminal/session.js';

/**
 * Telegram bridge input for converting `skill: prompt` messages into
 * `terminal_session` start payloads.
 */

export type OpencodeBridgeInput = {
  messageId: string;
  text: string;
  availableSkills: readonly string[];
  commandAllowlist: readonly string[];
  cwd?: string;
  pathEnv?: string;
  skillsMap?: Map<string, LoadedSkill>;
  gateRunner?: (input: {
    text: string;
    availableSkills: readonly string[];
    commandAllowlist: readonly string[];
    cwd?: string;
    pathEnv?: string;
  }) => SessionGateResult;
};

export type OpencodeBridgeResult =
  | { shouldHandle: false }
  | { shouldHandle: true; duplicate: true }
  | { shouldHandle: true; duplicate: false; toolInput?: JsonObject; userError?: string };

const seenMessageIds = new Set<string>();
const PREFIX_RE = /^\s*([a-z_][a-z0-9_-]*)\s*:/i;
const BRIDGE_ALIASES = new Set(['code_editor']);

/**
 * Builds a terminal_session start request for Telegram prefix commands.
 *
 * This function bridges Telegram skill commands (e.g., "opencode: create file.py") into
 * `terminal_session` MCP tool calls. It handles the full validation pipeline including
 * executable presence, command allowlist, and working directory validation.
 *
 * Behavior implemented by IMP:
 * - Only handles messages beginning with `<skill_or_alias>:` (prefix must match `[a-z_][a-z0-9_-]*`)
 * - Only accepts prefixes that match an available skill or `code_editor` alias (fallback)
 * - Deduplicates by message ID to prevent double-dispatch of the same command
 * - Runs terminal gates and returns a user-facing error on gate failure
 * - Maps CWD validation failures to `INVALID_CWD: <details>` for end-user clarity
 *
 * Gate failure mapping:
 * - CWD phase failures → "INVALID_CWD: ..." error message
 * - Other phase failures → Original gate error message
 *
 * Args:
 *   input: OpencodeBridgeInput containing text, available skills, command allowlist, and optional cwd
 *
 * Returns:
 *   OpencodeBridgeResult with one of:
 *   - { shouldHandle: false } — Message doesn't match skill prefix pattern
 *   - { shouldHandle: true, duplicate: true } — Message ID already processed
 *   - { shouldHandle: true, duplicate: false, toolInput: {...} } — Success; ready to dispatch
 *   - { shouldHandle: true, duplicate: false, userError: "..." } — Gate failed; send user warning
 *
 * Example:
 *   buildOpencodeTerminalSessionStart({
 *     messageId: "12345",
 *     text: "opencode: create hello.py",
 *     availableSkills: ['opencode'],
 *     commandAllowlist: ['opencode', 'git'],
 *     cwd: undefined  // Falls back to process.cwd()
 *   })
 *   => { shouldHandle: true, duplicate: false, toolInput: {...} }
 *
 * Error example (case-sensitive CWD mismatch):
 *   buildOpencodeTerminalSessionStart({
 *     messageId: "12345",
 *     text: "opencode: create hello.py",
 *     availableSkills: ['opencode'],
 *     commandAllowlist: ['opencode'],
 *     cwd: "/home/Username"  // But system path is /home/username (lowercase)
 *   })
 *   => { shouldHandle: true, duplicate: false, userError: "INVALID_CWD: Working directory '/home/Username' is not in the allowlist: [/home]" }
 */
export function buildOpencodeTerminalSessionStart(input: OpencodeBridgeInput): OpencodeBridgeResult {
  const text = input.text.trim();

  // Handle "opencode run /path --prompt" or "opencode /path --prompt" format FIRST
  // This must be checked before the prefix check because these messages don't have a colon
  // Regex uses (?:[^"\\]|\\.)* to properly capture escaped quotes like \" within the prompt value
  const runPromptMatch = text.match(/^opencode\s+(run\s+)?(\S+)\s+.*?--prompt\s+"((?:[^"\\]|\\.)*)"(?:\s+--approve\s+(?:"((?:[^"\\]|\\.)*)"|(\S+)))?/i);
  if (runPromptMatch) {
    // runPromptMatch[1] = "run " or undefined
    // runPromptMatch[2] = path (e.g., "/home/viper9009adr/Dev/TestingBOT")
    // runPromptMatch[3] = prompt
    // runPromptMatch[4] = approve value (quoted) or undefined
    // runPromptMatch[5] = approve value (unquoted) or undefined
    const path = runPromptMatch[2];
    const prompt = runPromptMatch[3];
    const approveRaw = runPromptMatch[4] ?? runPromptMatch[5];
    const approve = approveRaw ? (approveRaw.toLowerCase() === 'true' ? 'true' : 'false') : undefined;
    return {
      shouldHandle: true,
      duplicate: false,
      toolInput: {
        action: 'start',
        skillName: 'opencode',
        args: { prompt, ...(approve !== undefined ? { approve } : {}) },
        cwd: path,
      },
    };
  }

  const prefixMatch = PREFIX_RE.exec(text);
  if (!prefixMatch) return { shouldHandle: false };

  const requestedPrefix = (prefixMatch[1] ?? '').toLowerCase();
  const available = new Set(input.availableSkills.map((s) => s.toLowerCase()));
  if (!available.has(requestedPrefix) && !BRIDGE_ALIASES.has(requestedPrefix)) {
    return { shouldHandle: false };
  }

  // Extract skill-specific PATH before gate validation.
  // 
  // Root cause fix (implemented by IMP):
  // The `which` gate validates executable presence by checking `process.env.PATH`.
  // If a skill has custom executables in a non-standard location (e.g., `~/.opencode/bin`),
  // and a skill definition includes `env.PATH` that extends the system PATH, we must pass
  // that custom PATH to the gate. Otherwise, the executable check fails even if the command
  // is installed in the skill's custom location.
  // 
  // Fallback chain:
  // 1. skillDef?.env?.PATH — skill-specific PATH (highest priority, e.g., `~/.opencode/bin:/usr/bin:/bin`)
  // 2. input.pathEnv — explicit PATH passed by caller (e.g., from index.ts bootstrap)
  // 3. process.env.PATH — system PATH (fallback)
  // 
  // This ensures gate validation can find executables in skill-specific PATH before
  // spawning the terminal session.
  const skillDef = input.skillsMap?.get(requestedPrefix)?.definition;
  const skillPathEnv = skillDef?.env?.PATH ?? input.pathEnv ?? process.env.PATH;

  if (seenMessageIds.has(input.messageId)) {
    return { shouldHandle: true, duplicate: true };
  }
  seenMessageIds.add(input.messageId);

  const gate = (input.gateRunner ?? ((runnerInput) => runTerminalSessionGates({
    text: runnerInput.text,
    availableSkills: runnerInput.availableSkills,
    commandAllowlist: runnerInput.commandAllowlist,
    ...(runnerInput.cwd !== undefined ? { requestedCwd: runnerInput.cwd } : {}),
    ...(skillPathEnv !== undefined ? { pathEnv: skillPathEnv } : {}),
  })))({
    text,
    availableSkills: input.availableSkills,
    commandAllowlist: input.commandAllowlist,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(skillPathEnv !== undefined ? { pathEnv: skillPathEnv } : {}),
  });

if (!gate.pass) {
  const mappedError = gate.phase === 'cwd'
    ? `INVALID_CWD: ${gate.error}`
    : gate.error;
  return {
    shouldHandle: true,
    duplicate: false,
    userError: mappedError,
  };
}

// Parse cd command from payload (e.g., "cd /path , task" -> cwd: "/path", prompt: "task")
let resolvedCwd: string | undefined = gate.cwd;
let prompt = gate.payload;
const cdMatch = gate.payload.match(/^cd\s+(\S+)\s*,?\s*(.*)$/);
if (cdMatch) {
  resolvedCwd = cdMatch[1];
  prompt = cdMatch[2] ? cdMatch[2].trim() : '';
}

return {
  shouldHandle: true,
  duplicate: false,
  toolInput: {
    action: 'start',
    skillName: gate.skillName,
    args: { prompt, approve: 'true' },
    cwd: resolvedCwd,
  },
};
}

export function resetOpencodeBridgeForTests(): void {
  seenMessageIds.clear();
}
