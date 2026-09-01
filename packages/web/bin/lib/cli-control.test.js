import { describe, expect, it } from 'vitest';

import { requestControlAction, resolveControlTimeoutMs } from './cli-control.js';

describe('resolveControlTimeoutMs', () => {
  it('keeps the short default HTTP timeout for instant control calls', () => {
    expect(resolveControlTimeoutMs({}, {})).toBeUndefined();
    expect(resolveControlTimeoutMs({ wait: false, timeout: 30 }, {})).toBeUndefined();
  });

  it('outlives the default server wait window when wait is set', () => {
    expect(resolveControlTimeoutMs({ wait: true }, {})).toBe(630_000);
  });

  it('derives the HTTP timeout from an explicit wait timeout in seconds', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30 }, {})).toBe(60_000);
  });

  it('never shrinks an explicitly requested HTTP timeout', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30 }, { timeoutMs: 5000 })).toBe(5000);
  });

  it('allows a worktree to be provisioned without waiting for the session', () => {
    expect(resolveControlTimeoutMs({ worktree: 'feature' }, {})).toBe(120_000);
  });

  it('ignores a blank worktree name', () => {
    expect(resolveControlTimeoutMs({ worktree: '   ' }, {})).toBeUndefined();
  });

  it('covers provisioning and waiting in sequence when both are requested', () => {
    // The server creates the worktree before it begins waiting for the session,
    // so the client window must span both rather than the longer of the two.
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30, worktree: 'feature' }, {})).toBe(180_000);
    expect(resolveControlTimeoutMs({ wait: true, worktree: 'feature' }, {})).toBe(750_000);
  });
});

describe('requestControlAction recovery errors', () => {
  it('reports a cleaned session and the worktree that still requires recovery', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({
        error: 'Worktree recovery required',
        partial: true,
        partialAction: 'worktree-cleanup-pending',
        sessionId: 'ses_new',
        directory: '/repo/worktrees/side-task',
        worktree: { path: '/repo/worktrees/side-task', branch: 'openchamber/side-task' },
        sessionCleaned: true,
      }),
    });
    try {
      await expect(requestControlAction(54_321, 'session.create', {})).rejects.toThrow(
        'New session ses_new was deleted. Worktree /repo/worktrees/side-task on openchamber/side-task requires recovery.',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('labels a retained create partial as a new session', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({
        error: 'Prompt dispatch failed',
        partial: true,
        partialAction: 'session-retained',
        sessionId: 'ses_new',
        directory: '/repo/app',
      }),
    });
    try {
      let error;
      try {
        await requestControlAction(54_321, 'session.create', {});
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('New session ses_new remains available in /repo/app.');
      expect(error.message).not.toContain('Forked session');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});
