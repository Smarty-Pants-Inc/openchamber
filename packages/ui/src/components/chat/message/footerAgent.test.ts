import { describe, expect, test } from 'bun:test';
import { visibleFooterAgentName } from './footerAgent';

// smarty-code#126 F7 (b): the reply footer read "Claude Opus 5.5  build  1.4s" on an ordinary Pi session.
describe('visibleFooterAgentName', () => {
  test('hides the default build agent, which the gateway stamps on every ordinary Pi message', () => {
    expect(visibleFooterAgentName('build')).toBeUndefined();
    expect(visibleFooterAgentName(' Build ')).toBeUndefined();
  });

  test('keeps a chosen non-default agent and an absent agent stays absent', () => {
    expect(visibleFooterAgentName('plan')).toBe('plan');
    expect(visibleFooterAgentName(undefined)).toBeUndefined();
    expect(visibleFooterAgentName('')).toBeUndefined();
  });
});
