import { describe, expect, test } from 'bun:test';
import { appendTerminalContexts, extractTerminalContexts } from './terminalContext';

const context = {
  terminalId: 'term-1', terminalLabel: 'Terminal 1', startLine: 12, endLine: 13, text: 'one\r\ntwo',
};

describe('terminal context serialization', () => {
  test('normalizes immutable selection snapshots and line ranges', () => {
    const normalized = extractTerminalContexts(appendTerminalContexts('', [context]));
    expect(normalized.contexts[0]?.text).toBe('one\ntwo');
    expect(appendTerminalContexts('hello', [{ ...context, text: '\n\n' }])).toBe('hello');
    const bounded = extractTerminalContexts(appendTerminalContexts('', [{ ...context, startLine: -2, endLine: 0 }]));
    expect(bounded.contexts[0]?.startLine).toBe(1);
  });

  test('serializes multiple contexts without exposing the block in visible text', () => {
    const serialized = appendTerminalContexts('fix this', [context, { ...context, terminalId: 'term-2', terminalLabel: 'Build', startLine: 2, endLine: 2, text: 'failed' }]);
    const parsed = extractTerminalContexts(serialized);
    expect(parsed.visibleText).toBe('fix this');
    expect(parsed.contexts).toEqual([
      { terminalLabel: 'Terminal 1', startLine: 12, endLine: 13, text: 'one\ntwo' },
      { terminalLabel: 'Build', startLine: 2, endLine: 2, text: 'failed' },
    ]);
  });

  test('ignores empty historical contexts', () => {
    expect(appendTerminalContexts('hello', [{ ...context, text: '' }])).toBe('hello');
  });
});
