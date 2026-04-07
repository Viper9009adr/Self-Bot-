/**
 * src/types/tool.ts
 * MCP tool definitions, ToolResult, ToolArtifact, and ToolErrorCode enum.
 */
import type { z } from 'zod';

// ─── JsonSerializable ────────────────────────────────────────────────────────
export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonSerializable[];
export type JsonObject = { [key: string]: JsonSerializable | undefined };
export type JsonSerializable = JsonPrimitive | JsonArray | JsonObject;

// ─── ToolErrorCode ────────────────────────────────────────────────────────────
export enum ToolErrorCode {
  UNKNOWN = 'UNKNOWN',
  TIMEOUT = 'TIMEOUT',
  CAPTCHA = 'CAPTCHA',
  AUTH_FAILURE = 'AUTH_FAILURE',
  RATE_LIMITED = 'RATE_LIMITED',
  PARSE_ERROR = 'PARSE_ERROR',
  BROWSER_CRASH = 'BROWSER_CRASH',
  NETWORK_ERROR = 'NETWORK_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  NOT_FOUND = 'NOT_FOUND',
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  WORKER_UNAVAILABLE = 'WORKER_UNAVAILABLE',
  MEDIA_CAPABILITY_UNAVAILABLE = 'MEDIA_CAPABILITY_UNAVAILABLE',
}

// ─── ToolArtifact ─────────────────────────────────────────────────────────────
export type ArtifactType =
  | 'screenshot'
  | 'pdf'
  | 'csv'
  | 'html'
  | 'json'
  | 'text'
  | 'image';

export interface ToolArtifact {
  /** Unique artifact identifier */
  id: string;
  /** Artifact type discriminator */
  type: ArtifactType;
  /** Human-readable name */
  name: string;
  /** MIME type */
  mimeType: string;
  /** Base64-encoded content or URL */
  content: string;
  /** True if content is a URL (not inline base64) */
  isUrl: boolean;
  /** Byte size of the original content */
  sizeBytes?: number | undefined;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ─── ToolResult ───────────────────────────────────────────────────────────────
export interface ToolResult {
  /** Whether the tool executed successfully */
  success: boolean;
  /**
   * Structured, JSON-serializable result data.
   * Must be JsonSerializable (not `unknown`) for safe serialization.
   */
  data: JsonSerializable;
  /** Human-readable summary of the result */
  summary?: string | undefined;
  /** Error message if success=false */
  error?: string | undefined;
  /** Structured error code if success=false */
  errorCode?: ToolErrorCode | undefined;
  /** Whether a human needs to handle a CAPTCHA or auth challenge */
  humanHandoffRequired?: boolean | undefined;
  /** Generated artifacts (screenshots, files, etc.) */
  artifacts?: ToolArtifact[] | undefined;
  /** Execution time in milliseconds */
  durationMs?: number | undefined;
}

// ─── Meridian fetch_context outcome (v2) ─────────────────────────────────────
export enum MeridianFetchOutcome {
  OK = 'ok',
  NOT_FOUND = 'not_found',
  TTL_EXPIRED = 'ttl_expired',
  EMPTY = 'empty',
  MALFORMED = 'malformed',
  TRANSIENT_FAILURE = 'transient_failure',
}

// ─── ToolContext ──────────────────────────────────────────────────────────────
export interface ToolContext {
  /** Requesting user's ID */
  userId: string;
  /** Task identifier for tracing */
  taskId: string;
  /** Conversation ID */
  conversationId: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal | undefined;
  /** Logger instance (passed from AgentCore) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger?: any;
  /** Callback to deliver a generated image to the user. Populated per-request by AgentCore. */
  onImageGenerated?: (imageBase64: string, mimeType: string) => void;
  /** Callback to deliver synthesized speech to the user. Populated per-request by AgentCore. */
  onAudioGenerated?: (audioBase64: string, mimeType: string) => void;
}

// ─── MCPToolDefinition ───────────────────────────────────────────────────────
export interface MCPToolDefinition<TInput = JsonObject> {
  /** Tool name (snake_case) */
  name: string;
  /** Human-readable description for LLM */
  description: string;
  /** Zod v3 schema for input validation */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodType<TInput, any, any>;
  /** Execute the tool, returning a ToolResult */
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
}
