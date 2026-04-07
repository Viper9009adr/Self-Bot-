/**
 * Local typing shim for `pdf-parse`.
 *
 * Maintenance note (flagged by CRT): keep this declaration aligned with the
 * runtime package pinned in package.json. If `pdf-parse` changes its exported
 * function signature or result shape in a future upgrade, update this shim in
 * the same change set to prevent silent type drift.
 */
declare module 'pdf-parse' {
  export interface PDFParseOptions {
    max?: number;
  }

  export interface PDFParseResult {
    text: string;
    numpages: number;
  }

  export default function pdfParse(
    dataBuffer: Buffer,
    options?: PDFParseOptions,
  ): Promise<PDFParseResult>;
}
