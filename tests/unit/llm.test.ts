import { afterEach, describe, expect, it } from 'bun:test';
import {
  MODEL_INPUT_TOKEN_CAP_DEFAULT,
  MODEL_INPUT_TOKEN_CAP_MAX,
  MODEL_INPUT_TOKEN_CAP_MIN,
  getModelInputTokenCap,
} from '../../src/agent/llm.js';

const ORIGINAL_DEFAULT = process.env['LLM_INPUT_TOKEN_CAP_DEFAULT'];
const ORIGINAL_MODEL_CAPS = process.env['LLM_MODEL_INPUT_TOKEN_CAPS'];

afterEach(() => {
  if (ORIGINAL_DEFAULT === undefined) {
    delete process.env['LLM_INPUT_TOKEN_CAP_DEFAULT'];
  } else {
    process.env['LLM_INPUT_TOKEN_CAP_DEFAULT'] = ORIGINAL_DEFAULT;
  }

  if (ORIGINAL_MODEL_CAPS === undefined) {
    delete process.env['LLM_MODEL_INPUT_TOKEN_CAPS'];
  } else {
    process.env['LLM_MODEL_INPUT_TOKEN_CAPS'] = ORIGINAL_MODEL_CAPS;
  }
});

describe('LLM per-model input token cap parsing', () => {
  it('uses default cap when env vars are missing', () => {
    delete process.env['LLM_INPUT_TOKEN_CAP_DEFAULT'];
    delete process.env['LLM_MODEL_INPUT_TOKEN_CAPS'];

    expect(getModelInputTokenCap('gpt-4o')).toBe(MODEL_INPUT_TOKEN_CAP_DEFAULT);
  });

  it('parses trimmed integer defaults and per-model values', () => {
    process.env['LLM_INPUT_TOKEN_CAP_DEFAULT'] = '  9000  ';
    process.env['LLM_MODEL_INPUT_TOKEN_CAPS'] = ' gpt-4o : 12000 , claude-sonnet-4-20250514=15000 ';

    expect(getModelInputTokenCap('gpt-4o')).toBe(12000);
    expect(getModelInputTokenCap('claude-sonnet-4-20250514')).toBe(15000);
    expect(getModelInputTokenCap('unknown-model')).toBe(9000);
  });

  it('falls back to defaults for empty/non-integer/<=0 values', () => {
    process.env['LLM_INPUT_TOKEN_CAP_DEFAULT'] = ' '; // empty after trim -> fallback default
    process.env['LLM_MODEL_INPUT_TOKEN_CAPS'] = 'gpt-4o:abc,claude-sonnet-4-20250514:0';

    expect(getModelInputTokenCap('gpt-4o')).toBe(MODEL_INPUT_TOKEN_CAP_DEFAULT);
    expect(getModelInputTokenCap('claude-sonnet-4-20250514')).toBe(MODEL_INPUT_TOKEN_CAP_DEFAULT);
    expect(getModelInputTokenCap('unknown-model')).toBe(MODEL_INPUT_TOKEN_CAP_DEFAULT);
  });

  it('clamps default and per-model caps to configured bounds', () => {
    process.env['LLM_INPUT_TOKEN_CAP_DEFAULT'] = '1';
    process.env['LLM_MODEL_INPUT_TOKEN_CAPS'] = `gpt-4o:${MODEL_INPUT_TOKEN_CAP_MAX + 999}`;

    expect(getModelInputTokenCap('unknown-model')).toBe(MODEL_INPUT_TOKEN_CAP_MIN);
    expect(getModelInputTokenCap('gpt-4o')).toBe(MODEL_INPUT_TOKEN_CAP_MAX);
  });
});
