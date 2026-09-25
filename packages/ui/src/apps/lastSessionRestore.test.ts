import { expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { persistLastActiveSession } from '@/sync/last-session-cache';
import { lastSessionRestoreStep } from './lastSessionRestore';

class TestStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
// SAFETY: the restore step reads only the session id.
const session = (id: string) => ({ id }) as Session;
const captured = { sessionId: 'A', directory: '/repo' };

// smarty-code#113: the native mobile cold restore checks the person's intent before restoring or clearing anything.
test('the captured session is restored, or its stale pointer cleared, only while the pointer still names it', () => {
  const storage = new TestStorage();
  persistLastActiveSession('rt', captured, storage);
  const step = (activeSessions: Session[], currentSessionId: string | null = null, currentRuntime = 'rt') =>
    lastSessionRestoreStep({ capturedRuntime: 'rt', currentRuntime, persisted: captured, activeSessions, currentSessionId, storage });
  expect(step([session('A')])).toEqual({ kind: 'restore', session: session('A') });
  expect(step([])).toEqual({ kind: 'clear' });
  expect(step([session('A')], 'B')).toEqual({ kind: 'skip' });
  expect(step([session('A')], null, 'other')).toEqual({ kind: 'skip' });
  // B was selected while the snapshot loaded, and the snapshot no longer has A: B's pointer is kept.
  persistLastActiveSession('rt', { sessionId: 'B', directory: '/repo' }, storage);
  expect(step([], 'B')).toEqual({ kind: 'skip' });
  // A draft action cleared the pointer while the snapshot loaded: nothing is restored over the draft.
  storage.clear();
  expect(step([session('A')])).toEqual({ kind: 'skip' });
});
