import { describe, expect, it } from 'vitest';
import {
  SessionBackendPolicyError,
  assertForkSourceSession,
  authorizeManagedBackendStamp,
  assertSessionForkSourceBackend,
  authorizeSessionForkTarget,
  assertSessionSendBackend,
  foldSessionBackendHistory,
  resolveSessionForkSource,
  resolveSessionSend,
} from './session-backend-policy.js';

const session = (agentBackend, extra = {}) => {
  const openchamber = { ...(extra.openchamber || {}) };
  if (agentBackend) openchamber.agent_backend = agentBackend;
  return {
    id: 'source',
    metadata: {
      ...extra,
      openchamber,
    },
  };
};

const message = (providerID) => ({ info: { model: { providerID } } });

const expectPolicyError = (operation, code, messageText) => {
  expect(operation).toThrowError(SessionBackendPolicyError);
  expect(operation).toThrow(expect.objectContaining({ code, message: messageText }));
};

describe('session backend policy conformance', () => {
  it('streams every page and retains only the backend class between reads', async () => {
    const calls = [];
    const backendClass = await foldSessionBackendHistory(async (before) => {
      calls.push(before);
      if (!before) return { records: [message('omp'), message('omp')], nextCursor: 'older-a' };
      if (before === 'older-a') return { records: [message('omp')], nextCursor: 'older-b' };
      return { records: [message('omp')], nextCursor: null };
    });

    expect(backendClass).toBe('omp');
    expect(calls).toEqual([undefined, 'older-a', 'older-b']);
  });

  it('fails on mixed native or managed history before requesting another page', async () => {
    let reads = 0;
    await expect(foldSessionBackendHistory(async () => {
      reads += 1;
      return {
        records: [message('openai'), message('omp')],
        nextCursor: 'must-not-be-read',
      };
    })).rejects.toMatchObject({
      code: 'mixed-history',
      category: 'conflict',
      message: 'Mixed native/managed agent backend history cannot be used',
    });
    expect(reads).toBe(1);
  });

  it('stops paging as soon as an older page introduces a second backend class', async () => {
    const calls = [];
    await expect(foldSessionBackendHistory(async (before) => {
      calls.push(before);
      if (!before) return { records: [message('pi')], nextCursor: 'older' };
      return { records: [message('omp')], nextCursor: 'must-not-be-read' };
    })).rejects.toMatchObject({ code: 'mixed-history' });
    expect(calls).toEqual([undefined, 'older']);
  });

  it('fails closed on unreadable pages and invalid or stalled cursors', async () => {
    await expect(foldSessionBackendHistory(async () => ({ records: null, nextCursor: null })))
      .rejects.toMatchObject({ code: 'invalid-history-page', category: 'incomplete-history' });
    await expect(foldSessionBackendHistory(async () => ({ records: [], nextCursor: 42 })))
      .rejects.toMatchObject({ code: 'invalid-history-cursor', category: 'incomplete-history' });
    await expect(foldSessionBackendHistory(async () => ({ records: [], nextCursor: '   ' })))
      .rejects.toMatchObject({ code: 'invalid-history-cursor', category: 'incomplete-history' });

    let reads = 0;
    await expect(foldSessionBackendHistory(async () => {
      reads += 1;
      return { records: [], nextCursor: 'same' };
    })).rejects.toMatchObject({ code: 'stalled-history-cursor', category: 'incomplete-history' });
    expect(reads).toBe(2);

    const transportError = new Error('transport failed');
    await expect(foldSessionBackendHistory(async () => { throw transportError; })).rejects.toBe(transportError);
  });

  it('keeps send decisions identical for native, managed backends, and legacy backfill', () => {
    const native = resolveSessionSend({
      session: session(null),
      historyBackendClass: 'native',
    });
    expect(native).toEqual({ backend: null, backfillBackend: null });
    expect(assertSessionSendBackend({ backend: native.backend, providerID: 'openai' })).toBeUndefined();

    const legacyOmp = resolveSessionSend({
      session: session(null),
      historyBackendClass: 'omp',
    });
    expect(legacyOmp).toEqual({ backend: 'omp', backfillBackend: 'omp' });
    expect(assertSessionSendBackend({ backend: legacyOmp.backend, providerID: 'omp' })).toBeUndefined();

    const legacyCodex = resolveSessionSend({
      session: session(null),
      historyBackendClass: 'codex',
    });
    expect(legacyCodex).toEqual({ backend: 'codex', backfillBackend: 'codex' });
    expect(assertSessionSendBackend({ backend: legacyCodex.backend, providerID: 'codex' })).toBeUndefined();

    expectPolicyError(
      () => assertSessionSendBackend({ backend: native.backend, providerID: 'pi' }),
      'native-to-managed-send',
      'Native sessions cannot be converted to a managed agent backend by sending a prompt',
    );
    expectPolicyError(
      () => assertSessionSendBackend({ backend: legacyOmp.backend, providerID: 'openai' }),
      'managed-backend-change',
      'Managed agent session backend cannot be changed',
    );
    expectPolicyError(
      () => resolveSessionSend({ session: session('omp'), historyBackendClass: 'pi' }),
      'managed-backend-change',
      'Managed agent session backend cannot be changed',
    );
  });

  it.each([
    ['send', resolveSessionSend],
    ['fork', resolveSessionForkSource],
  ])('rejects managed metadata against native history for %s while allowing empty history', (_action, resolve) => {
    for (const backend of ['pi', 'omp']) {
      expect(resolve({
        session: session(backend),
        historyBackendClass: null,
      })).toEqual({ backend, backfillBackend: null });
      expectPolicyError(
        () => resolve({ session: session(backend), historyBackendClass: 'native' }),
        'managed-backend-change',
        'Managed Pi/OMP session backend cannot be changed',
      );
    }
  });

  it('keeps fork source, target, review, and child-stamp decisions unchanged', () => {
    expect(resolveSessionForkSource({
      session: session(null),
      historyBackendClass: 'native',
    })).toEqual({ backend: null, backfillBackend: null });
    expect(resolveSessionForkSource({
      session: session(null),
      historyBackendClass: 'omp',
    })).toEqual({ backend: 'omp', backfillBackend: 'omp' });
    expect(authorizeManagedBackendStamp({ session: session(null), providerID: 'omp' }))
      .toEqual({ backend: 'omp', backfillBackend: 'omp' });
    expect(authorizeManagedBackendStamp({ session: session('omp'), providerID: 'omp' }))
      .toEqual({ backend: 'omp', backfillBackend: null });
    expect(authorizeManagedBackendStamp({ session: session(null), providerID: 'codex' }))
      .toEqual({ backend: 'codex', backfillBackend: 'codex' });
    expect(authorizeSessionForkTarget({ sourceBackend: 'omp', targetProviderID: 'omp' })).toBeUndefined();
    expect(authorizeSessionForkTarget({ sourceBackend: 'codex', targetProviderID: 'codex' })).toBeUndefined();
    expect(authorizeSessionForkTarget({ sourceBackend: null, targetProviderID: 'openai' })).toBeUndefined();

    const review = session(null, { openchamber: { kind: 'review', originalSessionID: 'original' } });
    expectPolicyError(() => assertForkSourceSession(review), 'review-session-fork', 'Review sessions cannot be forked');
    const legacyPi = resolveSessionForkSource({ session: session(null), historyBackendClass: 'pi' });
    expect(legacyPi).toEqual({ backend: 'pi', backfillBackend: 'pi' });
    expectPolicyError(
      () => assertSessionForkSourceBackend(legacyPi.backend),
      'pi-session-fork',
      'Pi sessions cannot be forked',
    );
    expectPolicyError(
      () => authorizeSessionForkTarget({ sourceBackend: null, targetProviderID: 'pi' }),
      'pi-fork-target',
      'Pi sessions cannot be created by forking because startup dialogs require an interactive client',
    );
    expectPolicyError(
      () => authorizeSessionForkTarget({ sourceBackend: 'omp', targetProviderID: 'openai' }),
      'fork-backend-change',
      'Session backend cannot be changed by forking',
    );
    expectPolicyError(
      () => authorizeSessionForkTarget({ sourceBackend: null, targetProviderID: 'codex' }),
      'fork-backend-change',
      'Session backend cannot be changed by forking',
    );
    expectPolicyError(
      () => authorizeSessionForkTarget({ sourceBackend: 'codex', targetProviderID: 'omp' }),
      'fork-backend-change',
      'Session backend cannot be changed by forking',
    );
    expectPolicyError(
      () => authorizeManagedBackendStamp({ session: session('pi'), providerID: 'omp' }),
      'managed-backend-change',
      'Managed agent session backend cannot be changed',
    );
  });
});
