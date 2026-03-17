/**
 * src/mcp/tools/book-appointment.ts
 * book_appointment tool: schedule an appointment by composing fill_form.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { ToolResult, ToolContext, JsonSerializable } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import { FillFormTool } from './fill-form.js';
import { ScrapeWebsiteTool } from './scrape-website.js';

const BookAppointmentInput = z.object({
  url: z.string().url().describe('URL of the appointment booking page'),
  appointmentDetails: z
    .record(z.string())
    .describe(
      'Map of form field selectors to values for the appointment. ' +
      'e.g. {"#date": "2025-03-15", "#time": "10:00", "#name": "John Doe"}',
    ),
  submitSelector: z
    .string()
    .optional()
    .describe('CSS selector for the booking submit button'),
  confirmationSelector: z
    .string()
    .optional()
    .describe('CSS selector that appears on the confirmation page'),
  requiresLogin: z
    .boolean()
    .default(false)
    .describe('Whether the page requires prior authentication'),
  captureConfirmationScreenshot: z
    .boolean()
    .default(true)
    .describe('Capture a screenshot of the confirmation page'),
  timeoutMs: z.number().int().min(1000).max(120000).default(45000),
});

type BookAppointmentInput = z.infer<typeof BookAppointmentInput>;

export class BookAppointmentTool extends BaseTool<BookAppointmentInput> {
  readonly name = 'book_appointment';
  readonly description =
    'Book or schedule an appointment on a website. ' +
    'Provide the booking URL and appointment details as form field selectors to values. ' +
    'Optionally capture a confirmation screenshot. ' +
    'Detects CAPTCHA challenges and reports when human assistance is needed.';
  readonly inputSchema = BookAppointmentInput;

  private readonly fillFormTool = new FillFormTool();
  private readonly scrapeWebsiteTool = new ScrapeWebsiteTool();

  protected async run(input: BookAppointmentInput, context: ToolContext): Promise<ToolResult> {
    // Step 1: Optionally scrape the page to verify it's a booking page
    this.log.debug({ url: input.url }, 'Verifying booking page');

    const scrapeResult = await this.scrapeWebsiteTool.execute(
      {
        url: input.url,
        extractMode: 'structured',
        maxChars: 5000,
        waitForJs: false,
        timeoutMs: 15000,
      },
      context,
    );

    if (!scrapeResult.success) {
      this.log.warn({ url: input.url }, 'Could not scrape booking page, proceeding anyway');
    }

    // Step 2: Fill and submit the booking form
    const fillResult = await this.fillFormTool.execute(
      {
        url: input.url,
        fields: input.appointmentDetails,
        submitSelector: input.submitSelector,
        waitForSelector: input.confirmationSelector,
        captureScreenshot: input.captureConfirmationScreenshot,
        timeoutMs: input.timeoutMs,
      },
      context,
    );

    if (!fillResult.success) {
      const isCaptcha = fillResult.errorCode === ToolErrorCode.CAPTCHA;
      return {
        success: false,
        data: fillResult.data,
        error: isCaptcha
          ? 'CAPTCHA encountered during appointment booking. Human intervention required.'
          : fillResult.error ?? 'Appointment booking failed',
        errorCode: fillResult.errorCode,
        humanHandoffRequired: fillResult.humanHandoffRequired ?? isCaptcha,
        artifacts: fillResult.artifacts,
      };
    }

    // Compose booking summary from scraped page title + fill result
    const pageTitle: JsonSerializable =
      scrapeResult.success && typeof scrapeResult.data === 'object' && scrapeResult.data !== null
        ? ((scrapeResult.data as Record<string, JsonSerializable | undefined>)['title'] ?? 'Appointment booking page')
        : 'Appointment booking page';

    return {
      success: true,
      data: {
        booked: true,
        url: input.url,
        pageTitle,
        appointmentDetails: Object.keys(input.appointmentDetails).reduce(
          (acc, key) => {
            // Only include non-sensitive field values
            if (!key.toLowerCase().includes('password') && !key.toLowerCase().includes('secret')) {
              acc[key] = input.appointmentDetails[key] ?? '';
            }
            return acc;
          },
          {} as Record<string, string>,
        ),
        formResult: fillResult.data,
      },
      summary: `Appointment booked successfully on ${input.url}`,
      artifacts: fillResult.artifacts,
    };
  }
}
