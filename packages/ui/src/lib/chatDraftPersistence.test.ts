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
import { newSessionSlotKey, tabId } from './chatDraftTabs';
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

// smarty-code#461 on 3.56: tab A typed "alpha", tab B (same project) typed "beta", A reloaded and showed "beta": one
// saved New session slot per project, the last writer won. Each tab now has its own slot (a sessionStorage tab id).
describe('chatDraftPersistence: a New session draft per tab', () => {
  const session = getSafeSessionStorage();
  const asTab = (id: string) => session.setItem('openchamber.chatDraftTab', id);
  beforeEach(() => { storage.clear(); session.removeItem('openchamber.chatDraftTab'); });

  test('a second tab never overwrites the first tab\'s New session draft; each tab reads its own after a reload', () => {
    const draft = createChatDraftIdentity('runtime-a', '/repo', null)!;
    asTab('tab-A'); writeChatDraft(draft, 'alpha', []);
    asTab('tab-B'); writeChatDraft(draft, 'beta', []);
    asTab('tab-A'); expect(readChatDraft(draft).text).toBe('alpha');
    asTab('tab-B'); expect(readChatDraft(draft).text).toBe('beta');
    asTab('tab-A'); clearChatDraft(draft);
    asTab('tab-B'); expect(readChatDraft(draft).text).toBe('beta'); // A clearing its draft leaves B's.
  });

  test('counterexample: a session\'s draft stays one slot for every tab (it is that session\'s own text)', () => {
    const own = createChatDraftIdentity('runtime-a', '/repo', 'session-1')!;
    asTab('tab-A'); writeChatDraft(own, 'shared', []);
    asTab('tab-B'); expect(readChatDraft(own).text).toBe('shared');
  });

  test('a draft saved before this change is taken over by the first tab that reads it, once', () => {
    storage.setItem('openchamber.chatDrafts.v2', JSON.stringify({ version: 2, drafts: {
      [JSON.stringify(['runtime-a', '/repo', null])]: { text: 'older', confirmedMentions: [], touchedAt: 1 } } }));
    const draft = createChatDraftIdentity('runtime-a', '/repo', null)!;
    asTab('tab-A'); expect(readChatDraft(draft).text).toBe('older');
    asTab('tab-B'); expect(readChatDraft(draft).text).toBe('');
    asTab('tab-A'); expect(readChatDraft(draft).text).toBe('older');
  });
});

// #461: per-tab slots must not lose a closed tab's unsent text: a new tab takes it over, never an open tab's.
describe('chatDraftPersistence: a closed tab\'s New session draft', () => {
  const session = getSafeSessionStorage();
  const asTab = (id: string) => session.setItem('openchamber.chatDraftTab', id);
  beforeEach(() => { storage.clear(); session.removeItem('openchamber.chatDraftTab'); });

  test('a new tab copies the draft of a tab that was closed (its claim released at pagehide); the original stays', () => {
    const draft = createChatDraftIdentity('runtime-a', '/repo', null)!;
    asTab('tab-A'); writeChatDraft(draft, 'alpha', []);
    storage.removeItem('openchamber.chatDraftTabClaim:tab-A'); // A's page went away (pagehide released its claim).
    asTab('tab-C'); expect(readChatDraft(draft).text).toBe('alpha');
    asTab('tab-D'); expect(readChatDraft(draft).text).toBe(''); // Copied once, by C.
    asTab('tab-A'); expect(readChatDraft(draft).text).toBe('alpha'); // Never deleted: A (if it was only away) keeps it.
  });

  test('counterexample: a tab that is still open keeps its draft; a new tab starts empty', () => {
    const draft = createChatDraftIdentity('runtime-a', '/repo', null)!;
    asTab('tab-A'); writeChatDraft(draft, 'alpha', []); // A marked itself alive just now.
    asTab('tab-C'); expect(readChatDraft(draft).text).toBe('');
    asTab('tab-A'); expect(readChatDraft(draft).text).toBe('alpha');
  });
});

// openchamber#433 review 1: a suspended tab, a duplicated tab, and two tabs writing at once never lose a draft.
describe('chatDraftPersistence: review 1 draft-loss cases', () => {
  const session = getSafeSessionStorage();
  const asTab = (id: string) => session.setItem('openchamber.chatDraftTab', id);
  beforeEach(() => { storage.clear(); session.removeItem('openchamber.chatDraftTab'); });
  const draft = () => createChatDraftIdentity('runtime-a', '/repo', null)!;

  test('(1) a frozen or suspended open tab keeps its draft however long its timers stop: its claim, not a heartbeat, decides', () => {
    asTab('tab-A'); writeChatDraft(draft(), 'alpha', []);
    storage.setItem('openchamber.chatDraftTabClaim:tab-A', 'a-frozen-page'); // A's page still holds its claim.
    asTab('tab-B'); expect(readChatDraft(draft()).text).toBe(''); writeChatDraft(draft(), 'beta', []);
    expect(JSON.parse(storage.getItem(JSON.stringify(['runtime-a', '/repo', 'tab-A']).replace(/^/, 'openchamber.chatDraftSlot:')) ?? '{}').text).toBe('alpha');
  });

  test('(2) a duplicated tab (its sessionStorage copied, the original still open) takes its own id, starting from a copy', () => {
    asTab('tab-A'); writeChatDraft(draft(), 'alpha', []);
    asTab('tab-X'); tabId(); // Another tab ran in this process meanwhile.
    storage.setItem('openchamber.chatDraftTabClaim:tab-A', 'the-original-page'); // The original A still holds tab-A.
    asTab('tab-A'); const duplicate = tabId();
    expect(duplicate).not.toBe('tab-A');
    expect(readChatDraft(draft()).text).toBe('alpha'); // Starts from a copy.
    writeChatDraft(draft(), 'beta', []);
    expect(JSON.parse(storage.getItem('openchamber.chatDraftSlot:' + JSON.stringify(['runtime-a', '/repo', 'tab-A'])) ?? '{}').text).toBe('alpha');
  });

  test('(3) each tab\'s draft is its own storage key: a stale envelope rewrite by another tab drops nothing', () => {
    asTab('tab-A'); writeChatDraft(draft(), 'alpha', []);
    const stale = storage.getItem('openchamber.chatDrafts.v2');
    asTab('tab-B'); writeChatDraft(draft(), 'beta', []);
    storage.setItem('openchamber.chatDrafts.v2', stale ?? JSON.stringify({ version: 2, drafts: {} })); // Another tab's late write.
    asTab('tab-A'); expect(readChatDraft(draft()).text).toBe('alpha');
    asTab('tab-B'); expect(readChatDraft(draft()).text).toBe('beta');
  });
});
