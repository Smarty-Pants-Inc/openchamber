import { beforeEach, describe, expect, test } from 'bun:test';

import {
  clearChatDraft,
  claimChatDraftOwnership,
  consumeChatDraft,
  createChatDraftIdentity,
  getChatDraftIdentityKey,
  readChatDraft,
  subscribeChatDraftDeletion,
  subscribeChatDraftConsumption,
  writeChatDraft,
} from './chatDraftPersistence';
import { getSafeStorage } from '@/stores/utils/safeStorage';

const storage = getSafeStorage();

describe('chatDraftPersistence', () => {
  beforeEach(() => {
    storage.removeItem('openchamber.chatDrafts.v2');
  });

  test('isolates drafts by runtime, directory, and session', () => {
    const first = createChatDraftIdentity('runtime-a', '/repo-a/', 'session-1')!;
    const second = createChatDraftIdentity('runtime-b', '/repo-a', 'session-1')!;
    const third = createChatDraftIdentity('runtime-a', '/repo-b', 'session-1')!;
    writeChatDraft(first, 'first', ['file.ts']);
    writeChatDraft(second, 'second', []);
    writeChatDraft(third, 'third', []);

    expect(readChatDraft(first)).toEqual({ text: 'first', confirmedMentions: new Set(['file.ts']) });
    expect(readChatDraft(second).text).toBe('second');
    expect(readChatDraft(third).text).toBe('third');
  });

  test('keeps new-session drafts separate from similarly named sessions', () => {
    const newSession = createChatDraftIdentity('runtime-a', '/repo', null)!;
    const namedSession = createChatDraftIdentity('runtime-a', '/repo', '__new__')!;

    writeChatDraft(newSession, 'new session', []);
    writeChatDraft(namedSession, 'named session', []);

    expect(readChatDraft(newSession).text).toBe('new session');
    expect(readChatDraft(namedSession).text).toBe('named session');
  });

  test('clears only the matching identity and notifies active composers', () => {
    const deleted = createChatDraftIdentity('runtime-a', '/repo-a', 'session-1')!;
    const retained = createChatDraftIdentity('runtime-a', '/repo-b', 'session-1')!;
    const notifications: string[] = [];
    const unsubscribe = subscribeChatDraftDeletion((identity) => notifications.push(identity.directory));
    writeChatDraft(deleted, 'delete', []);
    writeChatDraft(retained, 'retain', []);

    clearChatDraft(deleted, true);
    unsubscribe();

    expect(readChatDraft(deleted).text).toBe('');
    expect(readChatDraft(retained).text).toBe('retain');
    expect(notifications).toEqual(['/repo-a']);
  });

  test('a replacement generation owns shared storage, including equal text and delayed old writes', () => {
    const original = createChatDraftIdentity('generation-test', '/repo', null, 1)!;
    const replacement = createChatDraftIdentity('generation-test', '/repo', null, 2)!;
    claimChatDraftOwnership(original); writeChatDraft(original, 'X', ['old.md']);
    claimChatDraftOwnership(replacement); writeChatDraft(replacement, 'X', ['new.md']);
    const notifications: string[] = [];
    const stop = subscribeChatDraftConsumption((_identity, text) => { notifications.push(text); });
    expect(consumeChatDraft(original, 'X')).toBe(false);
    writeChatDraft(original, 'delayed old flush', []);
    clearChatDraft(original, true);
    expect(readChatDraft(replacement)).toEqual({ text: 'X', confirmedMentions: new Set(['new.md']) });
    expect(notifications).toEqual([]);
    expect(getChatDraftIdentityKey(original)).toBe(getChatDraftIdentityKey(replacement));
    expect(storage.getItem('openchamber.chatDrafts.v2')).not.toContain('draftId');
    expect(consumeChatDraft(replacement, 'X')).toBe(true);
    expect(readChatDraft(replacement).text).toBe(''); expect(notifications).toEqual(['X']);
    stop();
  });

  test('a mounted consumer settles newer live edits before accepted saved-input cleanup', () => {
    const identity = createChatDraftIdentity('generation-live', '/repo', null, 1)!;
    claimChatDraftOwnership(identity); writeChatDraft(identity, 'X', []);
    const stop = subscribeChatDraftConsumption(target => { writeChatDraft(target, 'Y @new.md', ['new.md']); });
    expect(consumeChatDraft(identity, 'X')).toBe(true);
    expect(readChatDraft(identity)).toEqual({ text: 'Y @new.md', confirmedMentions: new Set(['new.md']) });
    stop();
  });

  test('bounds persisted drafts by recency', () => {
    for (let index = 0; index < 55; index += 1) {
      const identity = createChatDraftIdentity('runtime-a', '/repo', `session-${index}`)!;
      writeChatDraft(identity, `draft-${index}`, []);
    }

    const envelope = JSON.parse(storage.getItem('openchamber.chatDrafts.v2') ?? '{}') as { drafts?: object };
    expect(Object.keys(envelope.drafts ?? {})).toHaveLength(50);
  });

  test('reuses a parsed envelope while the stored value is unchanged', () => {
    const identity = createChatDraftIdentity('runtime-cache', '/repo', 'session-1')!;
    const key = getChatDraftIdentityKey(identity);
    storage.setItem('openchamber.chatDrafts.v2', JSON.stringify({
      version: 2,
      drafts: { [key]: { text: 'cached', confirmedMentions: [], touchedAt: 1 } },
    }));
    const originalParse = JSON.parse;
    let parseCalls = 0;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      parseCalls += 1;
      return originalParse(...args);
    }) as typeof JSON.parse;

    try {
      expect(readChatDraft(identity).text).toBe('cached');
      expect(readChatDraft(identity).text).toBe('cached');
      expect(parseCalls).toBe(1);
    } finally {
      JSON.parse = originalParse;
    }
  });
});
