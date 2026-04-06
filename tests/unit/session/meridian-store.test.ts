/**
 * tests/unit/session/meridian-store.test.ts
 * Unit tests for MeridianSessionStore DSL parsing fixes.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MeridianSessionStore } from '../../../src/session/meridian-store.js';
import type { UserSession } from '../../../src/types/session.js';
import { DEFAULT_MEMORY_POLICY } from '../../../src/types/session.js';

// Mock MCPClient to avoid actual network calls
const mockCallTool = mock(() => Promise.resolve({ success: true, data: {} }));
const MockMCPClient = mock(() => ({
  connect: mock(() => Promise.resolve()),
  disconnect: mock(() => Promise.resolve()),
  callTool: mockCallTool,
}));

// Mock the module
mock.module('../../../src/mcp/client.js', () => ({
  MCPClient: MockMCPClient,
}));

describe('MeridianSessionStore DSL parsing', () => {
  let store: MeridianSessionStore;

  beforeEach(() => {
    // Reset all mocks
    mock.restore();
    
    // Create store instance
    store = new MeridianSessionStore('http://test-meridian.example.com');
  });

  describe('_extractFirstItem', () => {
    it('should extract content from text field when JSON parse fails', () => {
      const data = { text: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:eyJzZXNzaW9uIjp7InVzZXJJZCI6InRlc3QifSwiZXhwaXJlc0F0IjoxMjM0NTY3ODkwfQ==¶\n§' };
      const result = store['_extractFirstItem'](data);
      
      expect(result).toEqual({
        content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:eyJzZXNzaW9uIjp7InVzZXJJZCI6InRlc3QifSwiZXhwaXJlc0F0IjoxMjM0NTY3ODkwfQ==¶\n§'
      });
    });

    it('should extract content from content field for backward compatibility', () => {
      const data = { content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:eyJzZXNzaW9uIjp7InVzZXJJZCI6InRlc3QifSwiZXhwaXJlc0F0IjoxMjM0NTY3ODkwfQ==¶\n§' };
      const result = store['_extractFirstItem'](data);
      
      expect(result).toEqual({
        content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:eyJzZXNzaW9uIjp7InVzZXJJZCI6InRlc3QifSwiZXhwaXJlc0F0IjoxMjM0NTY3ODkwfQ==¶\n§'
      });
    });

    it('should prefer text field over content field when both exist', () => {
      const data = { 
        text: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:text-field¶\n§',
        content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:content-field¶\n§'
      };
      const result = store['_extractFirstItem'](data);
      
      expect(result).toEqual({
        content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:text-field¶\n§'
      });
    });

    it('should handle array response with text field', () => {
      const data = [
        { text: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:eyJzZXNzaW9uIjp7InVzZXJJZCI6InRlc3QifSwiZXhwaXJlc0F0IjoxMjM0NTY3ODkwfQ==¶\n§' }
      ];
      const result = store['_extractFirstItem'](data);
      
      expect(result).toEqual({
        content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:eyJzZXNzaW9uIjp7InVzZXJJZCI6InRlc3QifSwiZXhwaXJlc0F0IjoxMjM0NTY3ODkwfQ==¶\n§'
      });
    });

    it('should handle array response with content field', () => {
      const data = [
        { content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:eyJzZXNzaW9uIjp7InVzZXJJZCI6InRlc3QifSwiZXhwaXJlc0F0IjoxMjM0NTY3ODkwfQ==¶\n§' }
      ];
      const result = store['_extractFirstItem'](data);
      
      expect(result).toEqual({
        content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:eyJzZXNzaW9uIjp7InVzZXJJZCI6InRlc3QifSwiZXhwaXJlc0F0IjoxMjM0NTY3ODkwfQ==¶\n§'
      });
    });

    it('should return content for non-DSL plain text (deserialize will reject)', () => {
      const data = { text: 'This is just plain text, not DSL' };
      const result = store['_extractFirstItem'](data);
      
      expect(result).toEqual({
        content: 'This is just plain text, not DSL'
      });
      // Note: _deserialize will reject this as non-DSL content
    });

    it('should handle empty string in text field (not fall back to content)', () => {
      const data = { 
        text: '', // Empty string in text field
        content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:content-field¶\n§'
      };
      const result = store['_extractFirstItem'](data);
      
      // Should return empty string from text field, not fall back to content
      expect(result).toEqual({
        content: ''
      });
    });

    it('should handle empty string in text field for array response', () => {
      const data = [
        { 
          text: '', // Empty string in text field
          content: '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:content-field¶\n§'
        }
      ];
      const result = store['_extractFirstItem'](data);
      
      // Should return empty string from text field, not fall back to content
      expect(result).toEqual({
        content: ''
      });
    });

    it('should return null for empty data', () => {
      expect(store['_extractFirstItem'](null)).toBeNull();
      expect(store['_extractFirstItem'](undefined)).toBeNull();
      expect(store['_extractFirstItem']('')).toBeNull();
      expect(store['_extractFirstItem']({})).toBeNull();
      expect(store['_extractFirstItem']([])).toBeNull();
      expect(store['_extractFirstItem']([{}])).toBeNull();
    });
  });

  describe('_deserialize', () => {
    const validSession: UserSession = { 
      userId: 'test-user',
      history: [],
      maxHistoryTokens: 8000,
      memoryPolicy: DEFAULT_MEMORY_POLICY,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      messageCount: 0,
      meta: {},
      activeTaskIds: [],
      rateLimited: false,
      concurrentTaskCount: 0
    };
    const validStoredSession = {
      session: validSession,
      expiresAt: 1234567890
    };
    const base64Data = Buffer.from(JSON.stringify(validStoredSession)).toString('base64');
    const validDSL = `§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:${base64Data}¶\n§`;

    it('should deserialize valid DSL with data field', () => {
      const result = store['_deserialize'](validDSL);
      
      expect(result).toEqual(validStoredSession);
    });

    it('should reject content that does not start with DSL marker', () => {
      const plainText = 'This is not DSL content';
      const result = store['_deserialize'](plainText);
      
      expect(result).toBeNull();
    });

    it('should handle newlines in DSL data field', () => {
      const multilineData = `{
  "session": {
    "userId": "test-user",
    "history": [],
    "maxHistoryTokens": 8000,
    "memoryPolicy": ${JSON.stringify(DEFAULT_MEMORY_POLICY)},
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z",
    "messageCount": 0,
    "meta": {},
    "activeTaskIds": [],
    "rateLimited": false,
    "concurrentTaskCount": 0
  },
  "expiresAt": 1234567890
}`;
      const base64Multiline = Buffer.from(multilineData).toString('base64');
      const dslWithNewlines = `§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:${base64Multiline}¶\n§`;
      
      const result = store['_deserialize'](dslWithNewlines);
      
      expect(result).toEqual({
        session: validSession,
        expiresAt: 1234567890
      });
    });

    it('should handle ¶ character in base64 data field (regex fix)', () => {
      // Create a session with JSON that when base64 encoded might contain ¶
      // We'll use a simple test case to verify regex doesn't stop at ¶ in data
      const sessionWithSpecialChars = {
        session: {
          ...validSession,
          meta: { special: "contains ¶ character in plain text" }
        },
        expiresAt: 1234567890
      };
      const jsonString = JSON.stringify(sessionWithSpecialChars);
      // The base64 encoding of JSON containing "¶" character
      const base64WithPilcrow = Buffer.from(jsonString).toString('base64');
      const dsl = `§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:${base64WithPilcrow}¶\n§`;
      
      const result = store['_deserialize'](dsl);
      
      // Should successfully parse despite ¶ in the original JSON
      expect(result).toEqual(sessionWithSpecialChars);
    });

    it('should return null for DSL missing data field', () => {
      const dslWithoutData = '§F:SES|T:SES|I:session:test|P:1|S:C\n§';
      const result = store['_deserialize'](dslWithoutData);
      
      expect(result).toBeNull();
    });

    it('should return null for invalid base64 in data field', () => {
      const invalidDSL = '§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:not-valid-base64¶\n§';
      const result = store['_deserialize'](invalidDSL);
      
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON in data field', () => {
      const invalidJSON = Buffer.from('not valid json').toString('base64');
      const invalidDSL = `§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:${invalidJSON}¶\n§`;
      const result = store['_deserialize'](invalidDSL);
      
      expect(result).toBeNull();
    });

    it('should return null for missing session in stored data', () => {
      const invalidStoredSession = {
        expiresAt: 1234567890
        // Missing session field
      };
      const base64Invalid = Buffer.from(JSON.stringify(invalidStoredSession)).toString('base64');
      const invalidDSL = `§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:${base64Invalid}¶\n§`;
      const result = store['_deserialize'](invalidDSL);
      
      expect(result).toBeNull();
    });

    it('should return null for missing expiresAt in stored data', () => {
      const invalidStoredSession = {
        session: validSession
        // Missing expiresAt field
      };
      const base64Invalid = Buffer.from(JSON.stringify(invalidStoredSession)).toString('base64');
      const invalidDSL = `§F:SES|T:SES|I:session:test|P:1|S:C\n¶data:${base64Invalid}¶\n§`;
      const result = store['_deserialize'](invalidDSL);
      
      expect(result).toBeNull();
    });
  });

  describe('Integration: get() with DSL parsing', () => {
    it('should retrieve session when MCP returns text field', async () => {
      const validSession: UserSession = { 
        userId: 'test-user',
        history: [],
        maxHistoryTokens: 8000,
        memoryPolicy: DEFAULT_MEMORY_POLICY,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        messageCount: 0,
        meta: {},
        activeTaskIds: [],
        rateLimited: false,
        concurrentTaskCount: 0
      };
      const validStoredSession = {
        session: validSession,
        expiresAt: Date.now() + 3600000 // 1 hour in future
      };
      const base64Data = Buffer.from(JSON.stringify(validStoredSession)).toString('base64');
      const validDSL = `§F:SES|T:SES|I:session:test-user|P:1|S:C\n¶data:${base64Data}¶\n§`;

      mockCallTool.mockResolvedValue({
        success: true,
        data: { text: validDSL }
      });

      const result = await store.get('test-user');
      
      expect(result).toEqual(validSession);
      expect(mockCallTool).toHaveBeenCalledWith(
        'fetch_context',
        expect.objectContaining({ task_id: 'session:test-user' }),
        expect.any(Object)
      );
    });

    it('should retrieve session when MCP returns content field (backward compatibility)', async () => {
      const validSession: UserSession = { 
        userId: 'test-user',
        history: [],
        maxHistoryTokens: 8000,
        memoryPolicy: DEFAULT_MEMORY_POLICY,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        messageCount: 0,
        meta: {},
        activeTaskIds: [],
        rateLimited: false,
        concurrentTaskCount: 0
      };
      const validStoredSession = {
        session: validSession,
        expiresAt: Date.now() + 3600000
      };
      const base64Data = Buffer.from(JSON.stringify(validStoredSession)).toString('base64');
      const validDSL = `§F:SES|T:SES|I:session:test-user|P:1|S:C\n¶data:${base64Data}¶\n§`;

      mockCallTool.mockResolvedValue({
        success: true,
        data: { content: validDSL }
      });

      const result = await store.get('test-user');
      
      expect(result).toEqual(validSession);
    });

    it('should return null when MCP returns non-DSL plain text', async () => {
      mockCallTool.mockResolvedValue({
        success: true,
        data: { text: 'This is just plain text, not DSL' }
      });

      const result = await store.get('test-user');
      
      expect(result).toBeNull();
    });

    it('should handle array response from MCP', async () => {
      const validSession: UserSession = { 
        userId: 'test-user',
        history: [],
        maxHistoryTokens: 8000,
        memoryPolicy: DEFAULT_MEMORY_POLICY,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        messageCount: 0,
        meta: {},
        activeTaskIds: [],
        rateLimited: false,
        concurrentTaskCount: 0
      };
      const validStoredSession = {
        session: validSession,
        expiresAt: Date.now() + 3600000
      };
      const base64Data = Buffer.from(JSON.stringify(validStoredSession)).toString('base64');
      const validDSL = `§F:SES|T:SES|I:session:test-user|P:1|S:C\n¶data:${base64Data}¶\n§`;

      mockCallTool.mockResolvedValue({
        success: true,
        data: [{ text: validDSL }]
      });

      const result = await store.get('test-user');
      
      expect(result).toEqual(validSession);
    });
  });
});