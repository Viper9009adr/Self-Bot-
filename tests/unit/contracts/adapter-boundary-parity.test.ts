/**
 * tests/unit/contracts/adapter-boundary-parity.test.ts
 * Verifies adapter boundary naming parity with backend shared contract.
 */
import { describe, it, expect } from 'bun:test';
import type {
  AdapterBoundary as BackendAdapterBoundary,
  InboundMessageHandler,
} from '../../../backend/apps/shared/contracts/adapter-boundary.ts';
import type { OutboundMessage } from '../../../backend/apps/shared/types/message.ts';
import type { AdapterBoundaryContract } from '../../../src/adapters/base.js';

const backendShape = {
  channel: 'telegram',
  initialize: async () => {},
  onMessage: (_handler: InboundMessageHandler) => () => {},
  send: async (_message: OutboundMessage) => {},
  shutdown: async () => {},
  isRunning: () => false,
} satisfies BackendAdapterBoundary;

const mobileBoundaryShape = {
  channel: 'telegram',
  initialize: async () => {},
  onMessage: (_handler: Parameters<AdapterBoundaryContract['onMessage']>[0]) => () => {},
  sendResponse: async (_message: Parameters<AdapterBoundaryContract['sendResponse']>[0]) => {},
  shutdown: async () => {},
  isRunning: () => false,
} satisfies AdapterBoundaryContract;

function normalizeBoundaryKeys(keys: string[]): string[] {
  return keys
    .map((k) => (k === 'sendResponse' ? 'send' : k))
    .sort((a, b) => a.localeCompare(b));
}

describe('adapter boundary parity (backend contract)', () => {
  it('matches backend method names after sendResponse -> send normalization', () => {
    const backendKeys = Object.keys(backendShape).sort((a, b) => a.localeCompare(b));
    const mobileKeys = normalizeBoundaryKeys(Object.keys(mobileBoundaryShape));

    expect(mobileKeys).toEqual(backendKeys);
  });
});
