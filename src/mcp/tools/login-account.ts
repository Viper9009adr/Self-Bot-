/**
 * src/mcp/tools/login-account.ts
 * login_account tool: authenticate to a website via browser-worker.
 * Credentials are EPHEMERAL — never stored in session history or logs.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { ToolResult, ToolContext, JsonSerializable, JsonObject } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import { getConfig } from '../../config/index.js';

const LoginAccountInput = z.object({
  url: z.string().url().describe('Login page URL'),
  usernameSelector: z
    .string()
    .default('input[name="username"], input[name="email"], input[type="email"]')
    .describe('CSS selector for username/email field'),
  passwordSelector: z
    .string()
    .default('input[name="password"], input[type="password"]')
    .describe('CSS selector for password field'),
  submitSelector: z
    .string()
    .default('button[type="submit"], input[type="submit"]')
    .describe('CSS selector for submit button'),
  successSelector: z
    .string()
    .optional()
    .describe('CSS selector that appears after successful login'),
  username: z.string().min(1).describe('Username or email (ephemeral, not stored)'),
  password: z.string().min(1).describe('Password (ephemeral, not stored)'),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

type LoginAccountInput = z.infer<typeof LoginAccountInput>;

interface BrowserResult {
  success: boolean;
  data?: Record<string, JsonSerializable | undefined>;
  screenshot?: string;
  error?: string;
  errorCode?: string;
  humanHandoffRequired?: boolean;
}

export class LoginAccountTool extends BaseTool<LoginAccountInput> {
  readonly name = 'login_account';
  readonly description =
    'Log in to a website using provided credentials. ' +
    'Credentials are used ephemerally and NEVER stored or logged. ' +
    'Detects CAPTCHA challenges and reports when human intervention is needed. ' +
    'Returns session state (cookies) on success, not the credentials themselves.';
  readonly inputSchema = LoginAccountInput;

  protected async run(input: LoginAccountInput, context: ToolContext): Promise<ToolResult> {
    const config = getConfig();
    const workerUrl = config.browserWorker.url;

    // Build the browser command — credentials are sent to browser-worker
    // but NEVER echoed back or stored in results/history
    const command = {
      action: 'login' as const,
      url: input.url,
      payload: {
        [input.usernameSelector]: input.username,
        [input.passwordSelector]: input.password,
      },
      options: {
        submitSelector: input.submitSelector,
        waitForSelector: input.successSelector,
        screenshotOnError: true,
        timeout: input.timeoutMs,
      },
    };

    let result: BrowserResult;
    try {
      const response = await fetch(`${workerUrl}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: context.signal ?? null,
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          success: false,
          data: null,
          error: `Browser worker returned HTTP ${response.status}: ${errText}`,
          errorCode: ToolErrorCode.WORKER_UNAVAILABLE,
        };
      }

      result = (await response.json()) as BrowserResult;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, data: null, error: 'Operation cancelled', errorCode: ToolErrorCode.TIMEOUT };
      }
      return {
        success: false,
        data: null,
        error: `Failed to contact browser worker: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: ToolErrorCode.WORKER_UNAVAILABLE,
      };
    }

    if (!result.success) {
      const errorCode = mapLoginErrorCode(result.errorCode);
      const isCaptcha = errorCode === ToolErrorCode.CAPTCHA;

      return {
        success: false,
        // Return only non-sensitive data — strip any echoed credentials
        data: sanitizeResult(result.data),
        error: isCaptcha
          ? 'CAPTCHA detected. Human intervention required to complete login.'
          : result.error ?? 'Login failed',
        errorCode,
        humanHandoffRequired: result.humanHandoffRequired ?? isCaptcha,
        ...(result.screenshot
          ? {
              artifacts: [
                {
                  id: `screenshot-${Date.now()}`,
                  type: 'screenshot' as const,
                  name: 'login-error.png',
                  mimeType: 'image/png',
                  content: result.screenshot,
                  isUrl: false,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : {}),
      };
    }

    return {
      success: true,
      // Return session data (cookies/tokens) but NEVER echo credentials
      data: {
        loggedIn: true,
        url: input.url,
        ...(result.data ? sanitizeResult(result.data) : {}),
      },
      summary: `Successfully logged in to ${input.url}`,
    };
  }
}

function mapLoginErrorCode(code: string | undefined): ToolErrorCode {
  switch (code) {
    case 'CAPTCHA': return ToolErrorCode.CAPTCHA;
    case 'AUTH_FAILURE': return ToolErrorCode.AUTH_FAILURE;
    case 'TIMEOUT': return ToolErrorCode.TIMEOUT;
    case 'RATE_LIMITED': return ToolErrorCode.RATE_LIMITED;
    default: return ToolErrorCode.UNKNOWN;
  }
}

/**
 * Remove any fields that might contain credential echoes.
 * Credentials should never appear in tool results.
 */
function sanitizeResult(data: Record<string, unknown> | undefined): JsonObject {
  if (!data) return {};
  const { password, passwd, credential, secret, token, ...safe } = data;
  void password; void passwd; void credential; void secret; void token;
  // Cast through unknown to satisfy JsonObject — the browser-worker only returns JSON-serializable data
  return safe as unknown as JsonObject;
}
