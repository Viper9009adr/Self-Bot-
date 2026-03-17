/**
 * Diagnostic test — find which field in the bot's full request causes 400.
 * Run with: bun test-oauth.ts
 */
import { readFileSync } from 'node:fs';

const tokens = JSON.parse(readFileSync('.oauth-tokens.json', 'utf8')) as { access_token: string };
const token = tokens.access_token;

const headers: Record<string, string> = {
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  'authorization': `Bearer ${token}`,
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
  'user-agent': 'claude-cli/2.1.77',
  'x-app': 'cli',
};

async function test(label: string, body: object): Promise<boolean> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ok = res.status === 200;
  console.log(`[${ok ? 'OK ' : 'FAIL'}] ${label} → ${res.status}: ${text.slice(0, 120)}`);
  return ok;
}

const systemIdentity = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
const systemBot = 'You are Self-BOT, an intelligent automation assistant.';
const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];

const tools = [
  {
    name: 'scrape_website',
    description: 'Fetch a webpage and extract its text content.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to scrape' },
      },
      required: ['url'],
    },
  },
];

// Test 1: system as string (what @ai-sdk/anthropic sends after our prefix)
await test('system as plain string', {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 64,
  system: `${systemIdentity}\n\n${systemBot}`,
  messages,
  stream: true,
});

// Test 2: system as array of two blocks (reference style)
await test('system as array [identity, bot]', {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 64,
  system: [
    { type: 'text', text: systemIdentity },
    { type: 'text', text: systemBot },
  ],
  messages,
  stream: true,
});

// Test 3: system as array one block (what @ai-sdk/anthropic actually sends)
await test('system as array [combined]', {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 64,
  system: [{ type: 'text', text: `${systemIdentity}\n\n${systemBot}` }],
  messages,
  stream: true,
});

// Test 4: with tools, system as array one block
await test('system array + tools', {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 64,
  system: [{ type: 'text', text: `${systemIdentity}\n\n${systemBot}` }],
  messages,
  tools,
  stream: true,
});

// Test 5: stream: false with system array
await test('stream:false + system array', {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 64,
  system: [{ type: 'text', text: `${systemIdentity}\n\n${systemBot}` }],
  messages,
  stream: false,
});

// Test 6: stream: true, no tools, system string
await test('stream:true + system string (no tools)', {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 64,
  system: `${systemIdentity}\n\n${systemBot}`,
  messages,
  stream: true,
});

// Test 7: stream: true, system array, no tools
await test('stream:true + system array (no tools)', {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 64,
  system: [{ type: 'text', text: `${systemIdentity}\n\n${systemBot}` }],
  messages,
  stream: true,
});
