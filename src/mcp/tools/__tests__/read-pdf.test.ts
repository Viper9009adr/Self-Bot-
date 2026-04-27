import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ToolContext } from '../../../types/tool.js';
import { ToolErrorCode } from '../../../types/tool.js';

const pdfParseMock = mock(async (buffer: Buffer) => ({
  text: `buffer-bytes:${buffer.length}`,
  numpages: 1,
}));

mock.module('pdf-parse', () => ({ default: pdfParseMock }));

const { ReadPDFTool } = await import('../read-pdf.js');

const context: ToolContext = {
  userId: 'user-test',
  taskId: 'task-test',
  conversationId: 'conv-test',
};

function withWhitespace(base64: string): string {
  return base64.match(/.{1,20}/g)?.join('\n  ') ?? base64;
}

function createPdfLikeBuffer(totalBytes: number, preamble = ''): Buffer {
  const prefix = Buffer.from(`${preamble}%PDF-1.7\n`, 'utf8');
  const body = Buffer.alloc(Math.max(totalBytes - prefix.length, 0), 0x20);
  return Buffer.concat([prefix, body]);
}

describe('ReadPDFTool base64 normalization', () => {
  beforeEach(() => {
    pdfParseMock.mockClear();
  });

  it('accepts plain base64 at the minimum threshold', async () => {
    const source = createPdfLikeBuffer(1024);
    const tool = new ReadPDFTool();

    const result = await tool.execute({ pdfBase64: source.toString('base64') }, context);

    expect(result.success).toBe(true);
    expect(pdfParseMock).toHaveBeenCalledTimes(1);
    const parsedBuffer = pdfParseMock.mock.calls[0]?.[0] as Buffer;
    expect(parsedBuffer.equals(source)).toBe(true);
  });

  it('accepts data URI wrapped base64 by stripping prefix', async () => {
    const source = createPdfLikeBuffer(1024, 'preamble-data\n');
    const tool = new ReadPDFTool();
    const pdfBase64 = `data:application/pdf;base64,${source.toString('base64')}`;

    const result = await tool.execute({ pdfBase64 }, context);

    expect(result.success).toBe(true);
    expect(pdfParseMock).toHaveBeenCalledTimes(1);
    const parsedBuffer = pdfParseMock.mock.calls[0]?.[0] as Buffer;
    expect(parsedBuffer.equals(source)).toBe(true);
  });

  it('accepts base64 containing whitespace', async () => {
    const source = createPdfLikeBuffer(1024, '\ufeff \n\tgarbage-before-header\n');
    const tool = new ReadPDFTool();

    const result = await tool.execute({ pdfBase64: withWhitespace(source.toString('base64')) }, context);

    expect(result.success).toBe(true);
    expect(pdfParseMock).toHaveBeenCalledTimes(1);
    const parsedBuffer = pdfParseMock.mock.calls[0]?.[0] as Buffer;
    expect(parsedBuffer.equals(source)).toBe(true);
  });

  it('rejects payloads smaller than the minimum threshold', async () => {
    const source = createPdfLikeBuffer(200);
    const tool = new ReadPDFTool();

    const result = await tool.execute({ pdfBase64: source.toString('base64') }, context);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.INVALID_INPUT);
    expect(result.error).toContain('Minimum size is 1KB');
    expect(pdfParseMock).not.toHaveBeenCalled();
  });

  it('rejects PK container payloads as unsupported file type', async () => {
    const source = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(1400, 0x00)]);
    const tool = new ReadPDFTool();

    const result = await tool.execute({ pdfBase64: source.toString('base64') }, context);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.INVALID_INPUT);
    expect(result.error).toContain('Unsupported file type');
    expect(result.error).toContain('ZIP/container');
    expect(result.error).not.toContain('too small');
    expect(pdfParseMock).not.toHaveBeenCalled();
  });

  it('accepts PDF signature after BOM and preamble within first 1KB', async () => {
    const source = createPdfLikeBuffer(1500, `\ufeff\n\n${'x'.repeat(100)}\n`);
    const tool = new ReadPDFTool();

    const result = await tool.execute({ pdfBase64: source.toString('base64') }, context);

    expect(result.success).toBe(true);
    expect(pdfParseMock).toHaveBeenCalledTimes(1);
    const parsedBuffer = pdfParseMock.mock.calls[0]?.[0] as Buffer;
    expect(parsedBuffer.equals(source)).toBe(true);
  });

  it('returns too-small for real PDF signatures below threshold', async () => {
    const source = createPdfLikeBuffer(300);
    const tool = new ReadPDFTool();

    const result = await tool.execute({ pdfBase64: source.toString('base64') }, context);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.INVALID_INPUT);
    expect(result.error).toContain('Minimum size is 1KB');
    expect(result.error).not.toContain('Unsupported file type');
    expect(pdfParseMock).not.toHaveBeenCalled();
  });
});
