import { describe, expect, test } from 'bun:test';
import {
  resolveSessionForkCapabilityForSubmit,
  type ChatSessionForkCapability,
  type ChatSessionForkTarget,
} from './ChatSessionCapabilities';

const target = (overrides: Partial<ChatSessionForkTarget> = {}): ChatSessionForkTarget => ({
  runtimeKey: 'runtime-a',
  directory: '/project',
  sessionId: 'session-a',
  ...overrides,
});

const runDestructiveBtwSubmit = async (
  capability: ChatSessionForkCapability,
  authorityTarget: ChatSessionForkTarget | null,
  submitTarget: ChatSessionForkTarget | null,
  refresh: (expectedTarget: ChatSessionForkTarget) => Promise<ChatSessionForkCapability>,
  destructiveSubmit: () => void,
): Promise<void> => {
  const resolved = await resolveSessionForkCapabilityForSubmit(
    capability,
    authorityTarget,
    submitTarget,
    refresh,
  );
  if (resolved !== 'supported') return;
  destructiveSubmit();
};

describe('resolveSessionForkCapabilityForSubmit', () => {
  test('preserves a BTW draft while authority is checking, unavailable, or errored', async () => {
    let destructiveSubmitCalls = 0;
    let checkingRefreshCalls = 0;
    let unsupportedRefreshCalls = 0;
    const destructiveSubmit = () => { destructiveSubmitCalls += 1; };
    const checkingRefresh = async () => {
      checkingRefreshCalls += 1;
      return 'error' as const;
    };
    const unsupportedRefresh = async () => {
      unsupportedRefreshCalls += 1;
      return 'unsupported' as const;
    };

    await runDestructiveBtwSubmit('checking', null, target(), checkingRefresh, destructiveSubmit);
    await runDestructiveBtwSubmit('error', null, target(), checkingRefresh, destructiveSubmit);
    await runDestructiveBtwSubmit('unsupported', null, target(), unsupportedRefresh, destructiveSubmit);
    await runDestructiveBtwSubmit('supported', target(), null, checkingRefresh, destructiveSubmit);

    expect(checkingRefreshCalls).toBe(2);
    expect(unsupportedRefreshCalls).toBe(1);
    expect(destructiveSubmitCalls).toBe(0);
  });

  test('allows destructive BTW submit only after current authority resolves supported', async () => {
    let destructiveSubmitCalls = 0;
    let refreshCalls = 0;
    const destructiveSubmit = () => { destructiveSubmitCalls += 1; };
    const refresh = async () => {
      refreshCalls += 1;
      return 'supported' as const;
    };
    const current = target();

    await runDestructiveBtwSubmit('checking', null, current, refresh, destructiveSubmit);
    await runDestructiveBtwSubmit('supported', current, current, refresh, destructiveSubmit);

    expect(refreshCalls).toBe(1);
    expect(destructiveSubmitCalls).toBe(2);
  });

  test('rechecks a stale supported capability instead of authorizing another target identity', async () => {
    const submitTarget = target({ sessionId: 'session-b' });
    const staleAuthorities = [
      target({ sessionId: 'session-a' }),
      target({ directory: '/other-project', sessionId: 'session-b' }),
      target({ runtimeKey: 'runtime-b', sessionId: 'session-b' }),
    ];
    const refreshedTargets: ChatSessionForkTarget[] = [];
    let destructiveSubmitCalls = 0;

    for (const staleAuthority of staleAuthorities) {
      await runDestructiveBtwSubmit(
        'supported',
        staleAuthority,
        submitTarget,
        async (expectedTarget) => {
          refreshedTargets.push(expectedTarget);
          return 'unsupported';
        },
        () => { destructiveSubmitCalls += 1; },
      );
    }

    expect(refreshedTargets).toEqual([submitTarget, submitTarget, submitTarget]);
    expect(destructiveSubmitCalls).toBe(0);
  });
});
