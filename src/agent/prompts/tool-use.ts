/**
 * src/agent/prompts/tool-use.ts
 * Tool-use instruction fragments for prompt composition.
 */

/**
 * Instruction fragment for CAPTCHA handling.
 */
export const CAPTCHA_INSTRUCTION = `
If any tool returns errorCode "CAPTCHA" or humanHandoffRequired=true:
1. STOP the current task immediately.
2. Inform the user: "⚠️ A CAPTCHA was encountered at [URL]. Please complete it manually in your browser, then let me know and I'll continue."
3. Do NOT retry the same tool call.
4. Wait for the user to confirm before proceeding.
`.trim();

/**
 * Instruction fragment for credential handling.
 */
export const CREDENTIAL_INSTRUCTION = `
When handling credentials (usernames, passwords, API keys):
1. Use them ONLY in the tool call parameters — never echo them in your response text.
2. After the tool call completes, treat the credentials as discarded.
3. If asked to "remember" a password, politely decline and explain you cannot store credentials for security reasons.
4. Suggest the user use a password manager instead.
`.trim();

/**
 * Instruction fragment for multi-step form tasks.
 */
export const MULTI_STEP_INSTRUCTION = `
For multi-step tasks (e.g., login then fill a form):
1. First verify the page is accessible by scraping it.
2. Complete prerequisite steps (login) before proceeding.
3. After each step, verify success by checking the page state.
4. If any step fails, report the failure clearly and ask the user how to proceed.
`.trim();

/**
 * Instruction fragment for tool retry policy.
 */
export const RETRY_INSTRUCTION = `
Tool retry policy:
- Retry TIMEOUT errors up to 2 times with increasing delay.
- Do NOT retry CAPTCHA, AUTH_FAILURE, or RATE_LIMITED errors.
- If a NETWORK_ERROR occurs, check if the URL is valid before retrying.
- After 3 consecutive failures, stop and report to the user.
`.trim();

/**
 * Get all tool-use instruction fragments as a combined string.
 */
export function getAllToolInstructions(): string {
  return [
    CAPTCHA_INSTRUCTION,
    CREDENTIAL_INSTRUCTION,
    MULTI_STEP_INSTRUCTION,
    RETRY_INSTRUCTION,
  ].join('\n\n');
}
