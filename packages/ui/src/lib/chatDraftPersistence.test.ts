import { beforeEach, describe, expect, test } from 'bun:test';
import './durableStorage.testing';

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
import { createTabDrafts, newSessionSlotKey, tabId } from './chatDraftTabs';
import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

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
    expect(storage.getItem(newSessionSlotKey('generation-test', '/repo')) ?? '').not.toContain('draftId');
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

// smarty-code#461: a New session draft saved before per-tab slots is taken over by the first page that reads it, and the
// old shared entry goes once that copy is stored. (Per-tab behaviour across pages: chatDraftTabs.test.ts.)
describe('chatDraftPersistence: the pre-#461 shared New session draft', () => {
  beforeEach(() => { storage.clear(); });
  test('the first read copies it into this tab and removes the old entry; a session draft is untouched', () => {
    storage.setItem('openchamber.chatDrafts.v2', JSON.stringify({ version: 2, drafts: {
      [JSON.stringify(['runtime-a', '/legacy-repo', null])]: { text: 'older', confirmedMentions: [], touchedAt: 1 },
      [JSON.stringify(['runtime-a', '/legacy-repo', 's1'])]: { text: 'in s1', confirmedMentions: [], touchedAt: 1 } } }));
    expect(readChatDraft(createChatDraftIdentity('runtime-a', '/legacy-repo', null)).text).toBe('older');
    expect(storage.getItem(newSessionSlotKey('runtime-a', '/legacy-repo')) ?? '').toContain('older');
    expect(storage.getItem('openchamber.chatDrafts.v2') ?? '').not.toContain('older');
    expect(readChatDraft(createChatDraftIdentity('runtime-a', '/legacy-repo', 's1')).text).toBe('in s1');
  });
});

// openchamber#433 round 5, P1 3: the pre-#461 shared draft through real persistence. A refused first copy leaves it; a
// later durable save or clear of this tab's draft finishes the migration, so no later tab is offered the old text; and
// another project's shared draft still migrates after a reload.
describe('chatDraftPersistence: migrating the pre-#461 shared draft', () => {
  const session = getSafeSessionStorage();
  beforeEach(() => { storage.clear(); session.removeItem('openchamber.chatDraftTab'); });
  const legacyEnvelope = (dirs: string[]) => storage.setItem('openchamber.chatDrafts.v2', JSON.stringify({ version: 2,
    drafts: Object.fromEntries(dirs.map(d => [JSON.stringify(['runtime-a', d, null]), { text: 'hello', confirmedMentions: [], touchedAt: 1 }])) }));
  for (const end of ['cleared', 'sent (consumeChatDraft)'] as const) test(`refused copy, storage recovers, then ${end}: a fresh tab is not offered "hello"`, () => {
    legacyEnvelope(['/mig']);
    const draft = createChatDraftIdentity('runtime-a', '/mig', null)!;
    // The browser's storage refuses the copy (quota): the safe-storage adapter keeps it in page memory and reports false.
    const backing = window.localStorage, realSet = backing.setItem;
    backing.setItem = (k: string, v: string) => { if (k.startsWith('openchamber.chatDraftSlot:')) throw new DOMException('quota', 'QuotaExceededError'); realSet.call(backing, k, v); };
    try { readChatDraft(draft); } finally { backing.setItem = realSet; }
    expect(storage.getItem('openchamber.chatDrafts.v2') ?? '').toContain('hello'); // So the shared draft stays.
    writeChatDraft(draft, 'hello', []); // The composer's retry, now stored.
    if (end === 'cleared') writeChatDraft(draft, '', []); else expect(consumeChatDraft(draft, 'hello')).toBe(true);
    expect(storage.getItem('openchamber.chatDrafts.v2') ?? '').not.toContain('hello');
    session.setItem('openchamber.chatDraftTab', 'a-fresh-tab'); // Another tab.
    expect(createTabDrafts({ storage, session }).readSlot('runtime-a', '/mig')).toBeUndefined();
    expect(readChatDraft(draft).text).toBe('');
  });
  test('upgrade with shared drafts in P and Q: open Q, reload, then open P: P\'s draft migrates', () => {
    legacyEnvelope(['/P', '/Q']);
    session.setItem('openchamber.chatDraftTab', tabId()); // This page's tab (its id is fixed for the page's life).
    expect(readChatDraft(createChatDraftIdentity('runtime-a', '/Q', null)).text).toBe('hello');
    expect(createTabDrafts({ storage, session }).readSlot('runtime-a', '/Q')?.text).toBe('hello'); // The reload.
    expect(readChatDraft(createChatDraftIdentity('runtime-a', '/P', null)).text).toBe('hello');
  });
});

// openchamber#433 round 4, P1 2 (the Send variant): a delivered text consumed by consumeChatDraft (as sent-start recovery
// does once delivery is confirmed) leaves a cleared marker, so no later page or fresh tab offers it again as unsent.
describe('chatDraftPersistence: a sent New session draft never comes back', () => {
  beforeEach(() => { storage.clear(); });
  test('consumed after delivery: a fresh tab of the project does not restore the sent text', async () => {
    const draft = createChatDraftIdentity('runtime-a', '/sent-repo', null)!;
    writeChatDraft(draft, 'hello, sent', []);
    expect(consumeChatDraft(draft, 'hello, sent')).toBe(true);
    expect(readChatDraft(draft).text).toBe('');
    const fresh = createTabDrafts({ storage, session: { getItem: () => null, setItem: () => undefined } });
    expect(fresh.readSlot('runtime-a', '/sent-repo')).toBeUndefined();
  });
});
