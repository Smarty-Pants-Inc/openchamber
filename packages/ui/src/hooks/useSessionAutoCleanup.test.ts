import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildAutoDeleteCandidates } from './useSessionAutoCleanup';

const DAY_MS = 24 * 60 * 60 * 1000;

const session = (id: string, updated: number, metadata?: Record<string, unknown>): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory: '/workspace',
  time: { created: updated, updated },
  ...(metadata ? { metadata } : {}),
});

describe('session auto-cleanup candidates', () => {
  test('excludes read-only Codex children before protecting the five newest mutable sessions', () => {
    const now = 100 * DAY_MS;
    const mutable = Array.from({ length: 6 }, (_, index) => session(
      `mutable-${index + 1}`,
      now - (index + 3) * DAY_MS,
    ));
    const readOnlyChild = session('codex-child', now - 2 * DAY_MS, {
      openchamber: { agent_backend: 'codex' },
      ompSubagent: true,
    });

    expect(buildAutoDeleteCandidates({
      sessions: [readOnlyChild, ...mutable],
      currentSessionId: null,
      cutoffDays: 1,
      now,
    })).toEqual(['mutable-6']);
  });
});
