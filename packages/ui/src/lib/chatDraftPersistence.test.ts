import { beforeEach, describe, expect, test } from 'bun:test';
import './durableStorage.testing';

import {
  clearChatDraft,
  claimChatDraftOwnership,
  consumeChatDraft,
  createChatDraftIdentity,
  getChatDraftIdentityKey,
  isChatDraftEphemeral,
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

// openchamber#433 round 6, P1 2 and 3, through the real safe-storage adapters (window.localStorage/sessionStorage refuse
// as a browser does at quota or by policy): a save is reload-safe only when the draft AND this tab's id are stored; a
// clear is done only when its empty draft is stored.
describe('chatDraftPersistence: reload safety of a tab draft (#433 r6)', () => {
  const session = getSafeSessionStorage();
  beforeEach(() => { storage.clear(); session.removeItem('openchamber.chatDraftTab'); });
  const refuse = (target: Storage, match: (k: string) => boolean, name = 'QuotaExceededError') => {
    const real = target.setItem;
    target.setItem = (k: string, v: string) => { if (match(k)) throw new DOMException('refused', name); real.call(target, k, v); };
    return () => { target.setItem = real; };
  };
  test('P1 2: the tab id is refused while the draft is stored: not reported as saved; once the id saves, a reload finds the draft', () => {
    const undo = refuse(window.sessionStorage, (k) => k === 'openchamber.chatDraftTab');
    const page1 = createTabDrafts({ storage, session });
    expect(page1.writeSlot('rt', '/r6', { text: 'alpha', confirmedMentions: [], touchedAt: 1 })).toBe(false);
    undo();
    expect(page1.writeSlot('rt', '/r6', { text: 'alpha', confirmedMentions: [], touchedAt: 2 })).toBe(true); // The retry.
    expect(createTabDrafts({ storage, session }).readSlot('rt', '/r6')?.text).toBe('alpha'); // The reload.
  });
  test('P1 2: a legacy copy whose tab id was refused does not remove the shared draft', () => {
    storage.setItem('openchamber.chatDrafts.v2', JSON.stringify({ version: 2, drafts: {
      [JSON.stringify(['rt', '/r6leg', null])]: { text: 'shared', confirmedMentions: [], touchedAt: 1 } } }));
    const undo = refuse(window.sessionStorage, (k) => k === 'openchamber.chatDraftTab');
    const page1 = createTabDrafts({ storage, session });
    try { expect(page1.adoptLegacy('rt', '/r6leg', { text: 'shared', confirmedMentions: [], touchedAt: 1 })).toEqual({ stored: false }); } finally { undo(); }
  });
  test('P1 3: a refused clear is reported and stays pending; after recovery the clear lands and a reload does not restore the text', () => {
    const page1 = createTabDrafts({ storage, session });
    expect(page1.writeSlot('rt', '/r6c', { text: 'hello', confirmedMentions: [], touchedAt: 1 })).toBe(true);
    const undo = refuse(window.localStorage, (k) => k.startsWith('openchamber.chatDraftSlot:'), 'SecurityError');
    expect(page1.writeSlot('rt', '/r6c', undefined)).toBe(false); // The clear did not reach storage: not acknowledged.
    undo();
    expect(page1.writeSlot('rt', '/r6c', undefined)).toBe(true); // The composer's retry (it keeps a failed clear pending).
    expect(createTabDrafts({ storage, session }).readSlot('rt', '/r6c')).toBeUndefined();
  });
  test('P1 3: a sent draft consumed while storage refuses it stays pending (warning on) and never returns once storage recovers', () => {
    const draft = createChatDraftIdentity('runtime-a', '/r6sent', null)!;
    writeChatDraft(draft, 'hello, sent', []);
    const undo = refuse(window.localStorage, (k) => k.startsWith('openchamber.chatDraftSlot:'), 'SecurityError');
    try { consumeChatDraft(draft, 'hello, sent'); expect(isChatDraftEphemeral()).toBe(true); } finally { undo(); }
    writeChatDraft(draft, '', []); // The composer's pending retry after recovery.
    expect(isChatDraftEphemeral()).toBe(false);
    expect(createTabDrafts({ storage, session }).readSlot('runtime-a', '/r6sent')).toBeUndefined();
  });
});

// openchamber#433 round 7: a failed clear of project P is owed per key. Storage refuses writes AND removals (both
// throw) through P's clear and the P -> Q navigation flush; it recovers while Q is active; Q's save must not acknowledge
// or forget P's clear. Back on P, and after a same-tab reload, P shows nothing.
describe('chatDraftPersistence: a failed clear survives navigation to another project (#433 r7)', () => {
  const session = getSafeSessionStorage();
  // This page's tab id is where a same-tab reload finds it (the module's page keeps its id for its life).
  beforeEach(() => { storage.clear(); session.setItem('openchamber.chatDraftTab', tabId()); });
  /** What a same-tab reload finds: the browser's own localStorage (the safe adapter's page-memory overrides are gone). */
  const afterReload = (directory: string) => {
    const raw = window.localStorage.getItem(newSessionSlotKey('runtime-a', directory));
    const text = raw === null ? '' : (JSON.parse(raw) as { text: string }).text;
    return text;
  };
  const refuseAll = () => {
    const ls = window.localStorage, set = ls.setItem, remove = ls.removeItem;
    ls.setItem = (k: string, v: string) => { if (k.startsWith('openchamber.chatDraftSlot:')) throw new DOMException('refused', 'SecurityError'); set.call(ls, k, v); };
    ls.removeItem = (k: string) => { if (k.startsWith('openchamber.chatDraftSlot:')) throw new DOMException('refused', 'SecurityError'); remove.call(ls, k); };
    return () => { ls.setItem = set; ls.removeItem = remove; };
  };
  for (const how of ['cleared', 'sent (consumeChatDraft)'] as const) test(`P ${how} while storage refuses, P -> Q -> P after recovery on Q, then a reload: P stays empty`, () => {
    const p = createChatDraftIdentity('runtime-a', `/r7-p-${how.length}`, null)!, q = createChatDraftIdentity('runtime-a', `/r7-q-${how.length}`, null)!;
    writeChatDraft(p, 'hello', []);
    const recover = refuseAll();
    if (how === 'cleared') writeChatDraft(p, '', []); else consumeChatDraft(p, 'hello');
    expect(isChatDraftEphemeral()).toBe(true);
    writeChatDraft(p, '', []); // The P -> Q outgoing flush: still refused.
    expect(isChatDraftEphemeral()).toBe(true);
    recover(); // Storage recovers while Q is active.
    writeChatDraft(q, 'draft in Q', []); // Q's save: it retries P's owed clear too.
    expect(isChatDraftEphemeral()).toBe(false);
    expect(readChatDraft(p).text).toBe(''); // Back on P.
    writeChatDraft(p, '', []); // P's debounce and unload flush (an unchanged empty draft).
    expect(afterReload(p.directory)).toBe(''); // A same-tab reload: P does not come back as 'hello'.
    expect(afterReload(q.directory)).toBe('draft in Q');
  });
  test('the owed clear is retried by P\'s own unchanged empty write when Q never saves', () => {
    const p = createChatDraftIdentity('runtime-a', '/r7-p-own', null)!;
    writeChatDraft(p, 'hello', []);
    const recover = refuseAll();
    writeChatDraft(p, '', []);
    recover();
    expect(readChatDraft(p).text).toBe(''); // Back on P: nothing shown, nothing saved yet.
    expect(writeChatDraft(p, '', [])).toBe(true); // The empty flush is not skipped: the clear lands.
    expect(afterReload('/r7-p-own')).toBe('');
  });
});
