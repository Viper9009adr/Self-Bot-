/**
 * src/mcp/tools/register-account.ts
 * register_account tool: create a new account on a website via browser-worker.
 * Credentials are EPHEMERAL — never stored in session history or logs.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { ToolResult, ToolContext, JsonSerializable, JsonObject } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import { getConfig } from '../../config/index.js';

const RegisterAccountInput = z.object({
  url: z.string().url().describe('Registration page URL'),
  fields: z
    .record(z.string())
    .describe(
      'Map of CSS selectors to values for the registration form. ' +
      'Password fields are transmitted ephemerally and never stored.',
    ),
  submitSelector: z
    .string()
    .default('button[type="submit"], input[type="submit"]')
    .describe('CSS selector for the registration submit button'),
  successSelector: z
    .string()
    .optional()
    .describe('CSS selector or text that appears after successful registration'),
  captureScreenshot: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

type RegisterAccountInput = z.infer<typeof RegisterAccountInput>;

interface BrowserResult {
  success: boolean;
  data?: Record<string, JsonSerializable | undefined>;
  screenshot?: string;
  error?: string;
  errorCode?: string;
  humanHandoffRequired?: boolean;
}

export class RegisterAccountTool extends BaseTool<RegisterAccountInput> {
  readonly name = 'register_account';
  readonly description =
    'Register a new account on a website. ' +
    'Provide a map of form field selectors to values. ' +
    'Credentials (passwords) are transmitted ephemerally to the browser and NEVER stored. ' +
    'Detects CAPTCHA challenges and reports when human intervention is required.';
  readonly inputSchema = RegisterAccountInput;

  protected async run(input: RegisterAccountInput, context: ToolContext): Promise<ToolResult> {
    const config = getConfig();
    const workerUrl = config.browserWorker.url;

    const command = {
      action: 'register' as const,
      url: input.url,
      payload: input.fields,
      options: {
        submitSelector: input.submitSelector,
        waitForSelector: input.successSelector,
        screenshotOnError: true,
        captureScreenshot: input.captureScreenshot,
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
        return {
          success: false,
          data: null,
          error: `Browser worker returned HTTP ${response.status}`,
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
      const errorCode = mapErrorCode(result.errorCode);
      const isCaptcha = errorCode === ToolErrorCode.CAPTCHA;

      return {
        success: false,
        data: sanitizeResult(result.data),
        error: isCaptcha
          ? 'CAPTCHA detected during registration. Human intervention required.'
          : result.error ?? 'Registration failed',
        errorCode,
        humanHandoffRequired: result.humanHandoffRequired ?? isCaptcha,
        ...(result.screenshot
          ? {
              artifacts: [
                {
                  id: `screenshot-${Date.now()}`,
                  type: 'screenshot' as const,
                  name: 'register-error.png',
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
      data: {
        registered: true,
        url: input.url,
        ...(result.data ? sanitizeResult(result.data) : {}),
      },
      summary: `Successfully registered an account on ${input.url}`,
      ...(result.screenshot
        ? {
            artifacts: [
              {
                id: `screenshot-${Date.now()}`,
                type: 'screenshot' as const,
                name: 'register-success.png',
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
}

function mapErrorCode(code: string | undefined): ToolErrorCode {
  switch (code) {
    case 'CAPTCHA': return ToolErrorCode.CAPTCHA;
    case 'AUTH_FAILURE': return ToolErrorCode.AUTH_FAILURE;
    case 'TIMEOUT': return ToolErrorCode.TIMEOUT;
    case 'RATE_LIMITED': return ToolErrorCode.RATE_LIMITED;
    default: return ToolErrorCode.UNKNOWN;
  }
}

function sanitizeResult(data: Record<string, unknown> | undefined): JsonObject {
  if (!data) return {};
  const { password, passwd, credential, secret, ...safe } = data;
  void password; void passwd; void credential; void secret;
  // Cast through unknown to satisfy JsonObject — the browser-worker only returns JSON-serializable data
  return safe as unknown as JsonObject;
}
