import { describe, it, expect } from 'bun:test';
import { applyShellQuotingRules, shellQuote } from '../terminal/executor';
import type { ShellQuotingRule } from '../terminal/types';

describe('Shell Quoting Rules', () => {
  it('should apply position 0 rule (do not quote run subcommand)', () => {
    const args = ['run', '--dangerously-skip-permissions', 'create test.py'];
    const rules: ShellQuotingRule[] = [
      { position: 0, quote: false },
      { position: -1, quote: true }
    ];
    
    const result = applyShellQuotingRules(args, rules);
    
    expect(result[0]).toBe('run');
    expect(result[1]).toBe('--dangerously-skip-permissions');
    expect(result[2]).toBe(shellQuote('create test.py'));
  });

  it('should apply position -1 rule (quote last argument)', () => {
    const args = ['run', 'flag', 'prompt message'];
    const rules: ShellQuotingRule[] = [
      { position: -1, quote: true }
    ];
    
    const result = applyShellQuotingRules(args, rules);
    
    expect(result[2]).toBe(shellQuote('prompt message'));
  });

  it('should handle mixed positions with flag preservation', () => {
    const args = ['run', '--flag', 'value'];
    const rules: ShellQuotingRule[] = [
      { position: 0, quote: false },
      { position: -1, quote: true }
    ];
    
    const result = applyShellQuotingRules(args, rules);
    
    expect(result[0]).toBe('run');
    expect(result[1]).toBe('--flag');
    expect(result[2]).toBe(shellQuote('value'));
  });

  it('should maintain backward compatibility (no shellQuoting rules)', () => {
    const args = ['run', '--flag', 'data'];
    const rules: ShellQuotingRule[] = [];
    
    const result = applyShellQuotingRules(args, rules);
    
    expect(result[0]).toBe(shellQuote('run'));
    expect(result[1]).toBe('--flag');
    expect(result[2]).toBe(shellQuote('data'));
  });

  it('should handle edge case: empty args array with position -1 rule', () => {
    const args: string[] = [];
    const rules: ShellQuotingRule[] = [
      { position: -1, quote: true }
    ];
    
    const result = applyShellQuotingRules(args, rules);
    
    expect(result.length).toBe(0);
  });
});
