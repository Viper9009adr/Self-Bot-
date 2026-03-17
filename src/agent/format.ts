/**
 * src/agent/format.ts
 * Post-processing utilities for LLM output formatting.
 *
 * Strips internal chain-of-thought (CoT) reasoning blocks so the user
 * only sees the clean, actionable response.
 */

/** Keywords that signal the start of a CoT block. */
const COT_KEYWORDS = /\b(?:Thinking|Action|Planning|Reasoning|Analysis)\b/i;

/**
 * Strip chain-of-thought reasoning blocks from an LLM response.
 *
 * Detects contiguous blockquote sections (lines starting with ">") whose
 * first line contains a CoT keyword (Thinking, Action, etc.) and removes
 * the entire block. Also strips standalone "**Thinking:**" header blocks.
 *
 * Returns the cleaned text with leading/trailing whitespace trimmed.
 * If stripping would produce empty output, returns the original text
 * (better to show CoT than nothing).
 */
export function stripCoTBlocks(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Detect start of a blockquote section (line starts with ">")
    if (/^>\s/.test(line) || line === '>') {
      // Collect the entire contiguous blockquote block
      const blockStart = i;
      const blockLines: string[] = [];
      while (i < lines.length && (/^>\s/.test(lines[i]!) || lines[i] === '>')) {
        blockLines.push(lines[i]!);
        i++;
      }

      // Check if the first line of this block contains a CoT keyword
      const firstLine = blockLines[0] ?? '';
      if (COT_KEYWORDS.test(firstLine)) {
        // Skip this entire blockquote block (CoT reasoning)
        continue;
      }

      // Not a CoT block — keep it
      result.push(...blockLines);
      continue;
    }

    // Detect standalone bold header CoT blocks: **Thinking:** ... or **Thinking**: ...
    // These continue until a blank line or another bold header or a heading
    const trimmedLine = line.trim();
    if (/^\*{1,2}(?:Thinking|Action|Planning|Reasoning|Analysis)(?:\*{0,2})?:/i.test(trimmedLine) ||
        /^\*{1,2}(?:Thinking|Action|Planning|Reasoning|Analysis):?\*{1,2}/i.test(trimmedLine)) {
      // Skip this line and any continuation lines
      i++;
      while (i < lines.length && lines[i]!.trim() !== '' && !/^\*{1,2}[A-Z]/.test(lines[i]!.trim()) && !/^#/.test(lines[i]!.trim())) {
        i++;
      }
      continue;
    }

    // Normal line — keep it
    result.push(line);
    i++;
  }

  let cleaned = result.join('\n');

  // Clean up excessive whitespace left behind
  cleaned = cleaned
    .replace(/\n{3,}/g, '\n\n')  // collapse triple+ newlines
    .trim();

  // Safety: never return empty string if original had content
  if (!cleaned && text.trim()) {
    return text.trim();
  }

  return cleaned;
}
