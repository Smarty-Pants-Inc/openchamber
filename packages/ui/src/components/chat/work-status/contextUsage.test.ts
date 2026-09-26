import { describe, expect, test } from 'bun:test';
import { computeContextUsage, sessionContextWindow, showsHeaderContextMeter } from './contextUsage';

const assistant = (tokens: Record<string, unknown>, id = 'msg') => ({ id, role: 'assistant', tokens });

describe('computeContextUsage', () => {
  test('sums every token bucket of the newest reporting assistant message', () => {
    const usage = computeContextUsage(
      [assistant({ input: 100, output: 20, reasoning: 5, cache: { read: 800, write: 75 } })],
      2000,
    );
    expect(usage?.totalTokens).toBe(1000);
    expect(usage?.percent).toBe(50);
  });

  test('reports the latest turn rather than a sum across turns', () => {
    // A turn's tokens describe that turn's window, so adding turns up would
    // report several times the real fill.
    const usage = computeContextUsage(
      [
        assistant({ input: 400, output: 0, reasoning: 0 }, 'old'),
        assistant({ input: 900, output: 0, reasoning: 0 }, 'new'),
      ],
      1000,
    );
    expect(usage?.totalTokens).toBe(900);
  });

  test('skips user messages and assistant turns that reported nothing', () => {
    const usage = computeContextUsage(
      [
        assistant({ input: 300, output: 0, reasoning: 0 }, 'real'),
        assistant({ input: 0, output: 0, reasoning: 0 }, 'zeroed'),
        { id: 'user', role: 'user' },
      ],
      1000,
    );
    expect(usage?.totalTokens).toBe(300);
  });

  test('leaves the percentage unrounded', () => {
    // Rounding here is what made the panel print "34.0%" against the header's
    // "33.6%".
    const usage = computeContextUsage([assistant({ input: 336, output: 0, reasoning: 0 })], 1000);
    expect(usage?.percent?.toFixed(1)).toBe('33.6');
  });

  test('shows the tokens with no percentage when the model exposes no window (never a guessed one)', () => {
    // smarty-dev#777 G14: a guessed 200k window showed a 1M-token session at "186.1%".
    expect(computeContextUsage([assistant({ input: 372_200, output: 0, reasoning: 0 })], 0))
      .toEqual({ totalTokens: 372_200, limit: 0, percent: null });
  });

  test('returns null when no message carries usable tokens', () => {
    expect(computeContextUsage([], 1000)).toBeNull();
    expect(computeContextUsage([{ id: 'u', role: 'user' }], 1000)).toBeNull();
    expect(computeContextUsage([assistant({ input: 0, output: 0, reasoning: 0 })], 1000)).toBeNull();
  });

  test('tolerates partial token payloads', () => {
    const usage = computeContextUsage([assistant({ input: 10 })], 100);
    expect(usage?.totalTokens).toBe(10);
  });

  test('prefers the server-reported total over summing round-trip fields', () => {
    // Real payload from opencode 1.18.18: ~14 tool-call round-trips accumulated
    // cache.read to 3.29M while the 1M window really held 232,872. Summing
    // rendered 330.6%; the reported total renders the real 23.3%.
    const usage = computeContextUsage(
      [assistant({ total: 232_872, input: 0, output: 14_523, reasoning: 0, cache: { read: 3_291_956, write: 0 } })],
      1_000_000,
    );
    expect(usage?.totalTokens).toBe(232_872);
    expect(usage?.percent?.toFixed(4)).toBe('23.2872');
  });

  test('selects a message whose only signal is the reported total', () => {
    const usage = computeContextUsage(
      [assistant({ total: 5_000, input: 0, output: 0, reasoning: 0 })],
      100_000,
    );
    expect(usage?.totalTokens).toBe(5_000);
  });
});

describe('sessionContextWindow (smarty-dev#777 G14)', () => {
  const providers = [
    { id: 'anthropic', models: [{ id: 'claude-opus-5-5', limit: { context: 1_000_000, output: 128_000 } }, { id: 'claude-haiku-4-5', limit: { context: 200_000 } }] },
    { id: 'local', models: [{ id: 'no-window' }] },
  ];
  const opus = { providerID: 'anthropic', modelID: 'claude-opus-5-5' };
  const haiku = { providerID: 'anthropic', modelID: 'claude-haiku-4-5' };
  const unknown = { providerID: 'local', modelID: 'no-window' };

  test("org's case: the session runs Opus 5.5 (1M) while the composer has another model selected", () => {
    const window = sessionContextWindow(providers, opus, [], haiku);
    expect(window).toEqual({ context: 1_000_000, output: 128_000 });
    expect(computeContextUsage([assistant({ input: 372_200, output: 0, reasoning: 0 })], window.context)?.percent?.toFixed(1)).toBe('37.2');
  });

  test("without a session model, the newest reply's model decides; the selection is the last choice", () => {
    const messages = [{ role: 'assistant', ...haiku }, { role: 'assistant', ...opus }];
    expect(sessionContextWindow(providers, null, messages, haiku).context).toBe(1_000_000);
    expect(sessionContextWindow(providers, null, [], haiku).context).toBe(200_000);
  });

  test("the session's model decides even when it reports no window: never another model's window", () => {
    expect(sessionContextWindow(providers, unknown, [{ role: 'assistant', ...opus }], haiku).context).toBe(0);
    expect(sessionContextWindow(providers, null, [{ role: 'assistant', ...unknown }], haiku).context).toBe(0);
    expect(sessionContextWindow([], opus, [], opus).context).toBe(0);
  });
});

describe('showsHeaderContextMeter (G14)', () => {
  const shown = { isVSCode: false, workStatusPanelVisible: false, retainedTokens: 372_200, contextLimit: 1_000_000 };
  test('shown with tokens and a known window', () => expect(showsHeaderContextMeter(shown)).toBe(true));
  test('hidden when the window is unknown from the start', () => expect(showsHeaderContextMeter({ ...shown, contextLimit: 0 })).toBe(false));
  test('hidden when a known window becomes unknown, even with a retained reading', () => {
    expect(showsHeaderContextMeter({ ...shown, contextLimit: 0, retainedTokens: 372_200 })).toBe(false);
  });
  test('hidden without tokens, in VS Code, or while the work-status panel shows the same figure', () => {
    expect(showsHeaderContextMeter({ ...shown, retainedTokens: 0 })).toBe(false);
    expect(showsHeaderContextMeter({ ...shown, isVSCode: true })).toBe(false);
    expect(showsHeaderContextMeter({ ...shown, workStatusPanelVisible: true })).toBe(false);
  });
});
