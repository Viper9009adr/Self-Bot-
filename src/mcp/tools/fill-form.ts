/**
 * src/mcp/tools/fill-form.ts
 * fill_form tool: fill and submit web forms via the browser-worker microservice.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { ToolResult, ToolContext, JsonSerializable } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import { getConfig } from '../../config/index.js';

const FillFormInput = z.object({
  url: z.string().url().describe('URL of the page containing the form'),
  fields: z
    .record(z.string())
    .describe('Map of CSS selector (or field name) to value to fill'),
  submitSelector: z
    .string()
    .optional()
    .describe('CSS selector for the submit button. If omitted, form is submitted automatically'),
  waitForSelector: z
    .string()
    .optional()
    .describe('CSS selector to wait for after submission (confirms success)'),
  captureScreenshot: z
    .boolean()
    .default(false)
    .describe('Capture a screenshot after form submission'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(30000)
    .describe('Timeout in milliseconds'),
});

type FillFormInput = z.infer<typeof FillFormInput>;

interface BrowserResult {
  success: boolean;
  data?: Record<string, JsonSerializable | undefined>;
  screenshot?: string;
  error?: string;
  errorCode?: string;
  humanHandoffRequired?: boolean;
}

export class FillFormTool extends BaseTool<FillFormInput> {
  readonly name = 'fill_form';
  readonly description =
    'Fill out and submit a web form on a given page. ' +
    'Provide the URL, a map of field selectors to values, and optionally a submit button selector. ' +
    'Detects CAPTCHAs and reports when human intervention is needed.';
  readonly inputSchema = FillFormInput;

  protected async run(input: FillFormInput, context: ToolContext): Promise<ToolResult> {
    const config = getConfig();
    const workerUrl = config.browserWorker.url;

    const command = {
      action: 'fill_form' as const,
      url: input.url,
      payload: input.fields,
      options: {
        submitSelector: input.submitSelector,
        waitForSelector: input.waitForSelector,
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
        return {
          success: false,
          data: null,
          error: 'Operation cancelled',
          errorCode: ToolErrorCode.TIMEOUT,
        };
      }
      return {
        success: false,
        data: null,
        error: `Failed to contact browser worker: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: ToolErrorCode.WORKER_UNAVAILABLE,
      };
    }

    if (!result.success) {
      const errorCode = mapBrowserErrorCode(result.errorCode);
      return {
        success: false,
        data: result.data ?? null,
        error: result.error ?? 'Form submission failed',
        errorCode,
        humanHandoffRequired: result.humanHandoffRequired ?? (errorCode === ToolErrorCode.CAPTCHA),
        ...(result.screenshot
          ? {
              artifacts: [
                {
                  id: `screenshot-${Date.now()}`,
                  type: 'screenshot' as const,
                  name: 'error-screenshot.png',
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
      data: result.data ?? { submitted: true, url: input.url },
      summary: `Form submitted successfully on ${input.url}`,
      ...(result.screenshot
        ? {
            artifacts: [
              {
                id: `screenshot-${Date.now()}`,
                type: 'screenshot' as const,
                name: 'form-result.png',
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

function mapBrowserErrorCode(code: string | undefined): ToolErrorCode {
  switch (code) {
    case 'CAPTCHA': return ToolErrorCode.CAPTCHA;
    case 'TIMEOUT': return ToolErrorCode.TIMEOUT;
    case 'AUTH_FAILURE': return ToolErrorCode.AUTH_FAILURE;
    case 'RATE_LIMITED': return ToolErrorCode.RATE_LIMITED;
    case 'PARSE_ERROR': return ToolErrorCode.PARSE_ERROR;
    case 'BROWSER_CRASH': return ToolErrorCode.BROWSER_CRASH;
    default: return ToolErrorCode.UNKNOWN;
  }
}
