/**
 * src/types/message.ts
 * Unified message and response types for cross-platform communication.
 */

// ─── Attachment ───────────────────────────────────────────────────────────────
export type AttachmentType = 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'location';

export interface BaseAttachment {
  type: AttachmentType;
  mimeType?: string | undefined;
  /** File size in bytes */
  size?: number | undefined;
}

export interface FileAttachment extends BaseAttachment {
  type: 'image' | 'document' | 'audio' | 'video' | 'sticker';
  /** Remote URL or file ID (platform-specific) */
  fileId: string;
  fileName?: string | undefined;
  /** Base64-encoded content if pre-fetched */
  data?: string | undefined;
}

export interface LocationAttachment extends BaseAttachment {
  type: 'location';
  latitude: number;
  longitude: number;
  title?: string | undefined;
}

export type Attachment = FileAttachment | LocationAttachment;

// ─── Platform Metadata ───────────────────────────────────────────────────────
export interface TelegramMetadata {
  platform: 'telegram';
  chatId: number;
  messageId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  username?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  /** Raw Grammy Update — not serialized to session */
  rawUpdate?: unknown;
}

export interface CliMetadata {
  platform: 'cli';
  sessionId: string;
}

export interface ApiMetadata {
  platform: 'api';
  requestId: string;
  sourceIp?: string | undefined;
}

export type PlatformMetadata = TelegramMetadata | CliMetadata | ApiMetadata;

// ─── UnifiedMessage ───────────────────────────────────────────────────────────
export interface UnifiedMessage {
  /** Unique message identifier (nanoid) */
  id: string;
  /** User identifier (stable across platforms) */
  userId: string;
  /** Conversation/channel identifier */
  conversationId: string;
  /** Plain text content */
  text: string;
  /** Attached files/media */
  attachments: Attachment[];
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Platform-specific metadata */
  platform: PlatformMetadata;
  /** Whether this is a command (e.g. starts with '/') */
  isCommand: boolean;
  /** Parsed command name if isCommand (without '/') */
  command?: string | undefined;
  /** Command arguments if isCommand */
  commandArgs?: string[] | undefined;
}

// ─── UnifiedResponse ─────────────────────────────────────────────────────────
export type ResponseFormat = 'text' | 'markdown' | 'html';

export interface UnifiedResponse {
  /** Echoes the original message id */
  inReplyTo: string;
  /** User to send the response to */
  userId: string;
  /** Conversation/channel to reply in */
  conversationId: string;
  /** Main response text */
  text: string;
  /** Format hint for rendering */
  format: ResponseFormat;
  /** Optional attachments to send back */
  attachments?: Attachment[] | undefined;
  /** Platform-specific metadata mirrored from the request */
  platform: PlatformMetadata;
  /** Indicates a streaming response (partial update) */
  isStreaming?: boolean | undefined;
  /** Stream sequence number for ordering */
  streamSeq?: number | undefined;
}

// ─── Message Roles (for LLM history) ─────────────────────────────────────────
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface HistoryMessage {
  role: MessageRole;
  content: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Tool call ID (for role='tool') */
  toolCallId?: string | undefined;
  /** Tool name (for role='tool') */
  toolName?: string | undefined;
}
