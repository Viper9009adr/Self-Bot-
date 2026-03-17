/**
 * src/agent/cot.ts
 * CoTPromptBuilder: build Chain-of-Thought enhanced prompts.
 */
import type { HistoryMessage } from '../types/message.js';
import type { MCPToolRegistry } from '../mcp/registry.js';
import { buildSystemPrompt } from './prompts/system.js';

export interface CoTPromptOptions {
  systemPromptBase?: string | undefined;
  toolRegistry?: MCPToolRegistry | undefined;
  extraInstructions?: string | undefined;
  userName?: string | undefined;
}

export interface BuiltPrompt {
  system: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
}

export class CoTPromptBuilder {
  private readonly options: CoTPromptOptions;

  constructor(options: CoTPromptOptions = {}) {
    this.options = options;
  }

  /**
   * Build the full prompt with system instructions and conversation history.
   */
  build(history: HistoryMessage[]): BuiltPrompt {
    const system = this.options.systemPromptBase
      ?? buildSystemPrompt({
        toolRegistry: this.options.toolRegistry,
        extraInstructions: this.options.extraInstructions,
        userName: this.options.userName,
      });

    // Convert history to LLM message format, filtering system messages
    // (system messages are passed separately as the system prompt)
    const messages = history
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant' | 'tool',
        content: m.content,
      }));

    return { system, messages };
  }

  /**
   * Build a CoT-augmented user message.
   * Prepends the CoT instruction to guide the LLM to reason step-by-step.
   */
  buildUserMessage(text: string, context?: string): string {
    if (!context) return text;
    return `${context}\n\n---\n\n${text}`;
  }

  /**
   * Extract the "thinking" part from an assistant response.
   * Returns null if no thinking block is found.
   */
  extractThinking(response: string): string | null {
    const match = response.match(/\*\*Thinking:\*\*\s*([\s\S]*?)(?=\*\*Action:\*\*|$)/);
    return match?.[1]?.trim() ?? null;
  }

  /**
   * Strip thinking blocks from a response for clean display.
   */
  cleanResponse(response: string): string {
    return response
      .replace(/>\s*\*\*Thinking:\*\*[\s\S]*?\n>\s*\*\*Action:\*\*/g, '')
      .replace(/>\s*\*\*(Thinking|Action):\*\*[^\n]*/g, '')
      .trim();
  }

  /**
   * Update options (useful for dynamic tool registry).
   */
  withToolRegistry(registry: MCPToolRegistry): CoTPromptBuilder {
    return new CoTPromptBuilder({ ...this.options, toolRegistry: registry });
  }
}
