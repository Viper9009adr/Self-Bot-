import { detectTerminalIntent, type IntentPhase } from '../agent/intent.js';
import { resolveSkillAlias, type AliasPhase } from '../agent/alias.js';
import { precheckExecutable, type WhichPhase } from './which.js';
import { normalizeAndValidateCwd, type CwdPhase } from '../mcp/cwd.js';

/**
 * Runs terminal safety/validation gates in fixed phase order.
 *
 * Phase order implemented by IMP: intent -> alias -> which -> cwd -> val.
 * On failure, previously successful phases are rolled back in reverse order.
 */

export type GatePhase = 'intent' | 'alias' | 'which' | 'cwd' | 'val';

export type SessionGateInput = {
  text: string;
  availableSkills: readonly string[];
  commandAllowlist: readonly string[];
  requestedCwd?: string;
  pathEnv?: string;
  validate?: (state: SessionGatePassResult) => { pass: boolean; error?: string };
  rollback?: Partial<Record<GatePhase, () => void>>;
  intentFn?: (text: string) => IntentPhase;
  aliasFn?: (hint: string, availableSkills: readonly string[]) => AliasPhase;
  whichFn?: (command: string, pathEnv?: string) => WhichPhase;
  cwdFn?: (rawCwd: string | undefined) => CwdPhase;
};

export type SessionGatePassResult = {
  pass: true;
  phase: 'val';
  skillName: string;
  payload: string;
  cwd: string;
  usedFallback: boolean;
};

export type SessionGateFailResult = {
  pass: false;
  phase: GatePhase;
  error: string;
  rolledBack: GatePhase[];
};

export type SessionGateResult = SessionGatePassResult | SessionGateFailResult;

/**
 * Execute the terminal gate pipeline and return pass/fail metadata.
 *
 * This function orchestrates the 5-phase validation pipeline for terminal session startup:
 *
 * 1. **intent** — Parses the input text for `skill: payload` format
 * 2. **alias** — Resolves skill name or falls back to alias (e.g., code_editor → opencode)
 * 3. **which** — Verifies command is in allowlist and executable exists
 * 4. **cwd** — Normalizes and validates working directory existence
 * 5. **val** — Optional custom validation hook
 *
 * **Rollback semantics:**
 * When any phase fails, all previously successful phases are rolled back in reverse order
 * (phase 4 → 3 → 2 → 1 → 0) via the input.rollback callback map.
 *
 * Args:
 *   input: SessionGateInput with text, skills, allowlists, and optional custom validators
 *
 * Returns:
 *   SessionGateResult with one of:
 *   - { pass: true, phase: 'val', skillName, payload, cwd, usedFallback } — All gates passed
 *   - { pass: false, phase: <phase_name>, error: "...", rolledBack: [...] } — Gate failed
 *
 * The CWD phase is particularly important for security: it ensures that resolved paths
 * match the TERMINAL_CWD_ALLOWLIST configuration and exist as directories.
 * Failures here return error messages like "INVALID_CWD: Working directory '/path' is not in the allowlist"
 * which get surfaced to end users in Telegram (via buildOpencodeTerminalSessionStart).
 */
export function runTerminalSessionGates(input: SessionGateInput): SessionGateResult {
  const rollbacks: GatePhase[] = [];

  const rollbackFromFailure = (): GatePhase[] => {
    const done = [...rollbacks].reverse();
    for (const phase of done) input.rollback?.[phase]?.();
    return done;
  };

  const intent = (input.intentFn ?? detectTerminalIntent)(input.text);
  if (!intent.pass || !intent.skillHint || !intent.payload) {
    return { pass: false, phase: 'intent', error: intent.error ?? 'Intent gate failed', rolledBack: rollbackFromFailure() };
  }
  rollbacks.push('intent');

  const alias = (input.aliasFn ?? resolveSkillAlias)(intent.skillHint, input.availableSkills);
  if (!alias.pass || !alias.resolved) {
    return { pass: false, phase: 'alias', error: alias.error ?? 'Alias gate failed', rolledBack: rollbackFromFailure() };
  }
  rollbacks.push('alias');

  if (!input.commandAllowlist.map((c) => c.toLowerCase()).includes(alias.resolved)) {
    return {
      pass: false,
      phase: 'which',
      error: `Command '${alias.resolved}' is not allowed`,
      rolledBack: rollbackFromFailure(),
    };
  }

  const which = (input.whichFn ?? precheckExecutable)(alias.resolved, input.pathEnv);
  if (!which.pass) {
    return { pass: false, phase: 'which', error: which.error ?? 'Executable gate failed', rolledBack: rollbackFromFailure() };
  }
  rollbacks.push('which');

  const cwd = (input.cwdFn ?? normalizeAndValidateCwd)(input.requestedCwd);
  if (!cwd.pass || !cwd.cwd) {
    return { pass: false, phase: 'cwd', error: cwd.error ?? 'cwd gate failed', rolledBack: rollbackFromFailure() };
  }
  rollbacks.push('cwd');

  const passResult: SessionGatePassResult = {
    pass: true,
    phase: 'val',
    skillName: alias.resolved,
    payload: intent.payload,
    cwd: cwd.cwd,
    usedFallback: alias.usedFallback,
  };

  const validation = input.validate?.(passResult) ?? { pass: true };
  if (!validation.pass) {
    return {
      pass: false,
      phase: 'val',
      error: validation.error ?? 'Validation gate failed',
      rolledBack: rollbackFromFailure(),
    };
  }

  return passResult;
}
