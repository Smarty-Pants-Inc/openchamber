import { describe, expect, test } from 'bun:test';
import './durableStorage.testing';
import {
  consumeChatDraft, isChatDraftEphemeral, readChatDraft, readChatDraftSince, writeChatDraft,
} from './chatDraftPersistence';
import { createTabDrafts, hasUnsaved, newSessionSlotKey, tabId } from './chatDraftTabs';
import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

const storage = getSafeStorage(), session = getSafeSessionStorage();
const envelopeKey = 'openchamber.chatDrafts.v2';
const identity = (directory: string, sessionId: string | null = null) => ({
  runtimeKey: 'envelope-retry-1117', directory, sessionId,
});

// The adapters are real: failed writes stay in page memory. Reload assertions
// deliberately bypass them, reading only bytes the browser actually accepted.
function fault() {
  const backing = window.localStorage, set = backing.setItem, remove = backing.removeItem;
  const blocked = new Set<string>();
  backing.setItem = (key, value) => {
    if (blocked.has(key)) throw new DOMException('refused', 'SecurityError');
    set.call(backing, key, value);
  };
  backing.removeItem = key => {
    if (blocked.has(key)) throw new DOMException('refused', 'SecurityError');
    remove.call(backing, key);
  };
  return { blocked, restore: () => { backing.setItem = set; backing.removeItem = remove; } };
}
function browserReloadText(key: string) {
  const raw = window.localStorage.getItem(key);
  return raw === null ? '' : JSON.parse(raw).text;
}
function clean(drafts: ReturnType<typeof identity>[]) {
  // Drain the singleton's pending keys even when an assertion failed, then reset
  // both backing bytes and adapter memory. No pending state leaks to later tests.
  for (const draft of drafts) writeChatDraft(draft, '', []);
  writeChatDraft(identity('/cleanup', 'S'), '', []);
  storage.clear();
}

describe('session envelope saves retry owed tab slots (#1117)', () => {
  for (const end of ['clear', 'confirmed send'] as const) {
    test(`${end}: materialize P to S; only session saves after recovery clear P across a same-tab reload`, () => {
      const p = identity(`/P-${end}`), s = identity(p.directory, 'S');
      const key = newSessionSlotKey(p.runtimeKey, p.directory), f = fault();
      session.setItem('openchamber.chatDraftTab', tabId());
      try {
        expect(writeChatDraft(p, 'delivered @sent.md', ['sent.md'], 10)).toBe(true);
        f.blocked.add(key);
        if (end === 'clear') expect(writeChatDraft(p, '', [])).toBe(false);
        else expect(consumeChatDraft(p, 'delivered @sent.md', 20)).toBe(true);
        expect(readChatDraft(p).text).toBe('');
        expect(isChatDraftEphemeral()).toBe(true);
        expect(browserReloadText(key)).toBe('delivered @sent.md');
        // Identity is now S; an accepted envelope must not forgive a refused P.
        expect(writeChatDraft(s, 'next in S @next.md', ['next.md'], 30)).toBe(true);
        expect(isChatDraftEphemeral()).toBe(true);
        expect(hasUnsaved()).toBe(true);
        expect(browserReloadText(key)).toBe('delivered @sent.md');
        f.blocked.clear();
        expect(writeChatDraft(s, 'next in S @next.md', ['next.md'], 30)).toBe(true);
        expect(browserReloadText(key)).toBe('');
        expect(hasUnsaved()).toBe(false);
        expect(isChatDraftEphemeral()).toBe(false);
        expect(readChatDraft(s)).toEqual({ text: 'next in S @next.md', confirmedMentions: new Set(['next.md']) });
        expect(window.localStorage.getItem(envelopeKey)).toContain('next in S @next.md');
      } finally { f.restore(); clean([p, s]); }
    });
  }

  test('a failed envelope does not acknowledge pending clears; recovery through S saves both', () => {
    const p = identity('/failed-envelope'), s = identity(p.directory, 'S');
    const key = newSessionSlotKey(p.runtimeKey, p.directory), f = fault();
    try {
      writeChatDraft(p, 'old P', []);
      f.blocked.add(key); f.blocked.add(envelopeKey);
      expect(writeChatDraft(p, '', [])).toBe(false);
      expect(writeChatDraft(s, 'live S', [])).toBe(false);
      expect(hasUnsaved()).toBe(true);
      expect(isChatDraftEphemeral()).toBe(true);
      expect(browserReloadText(key)).toBe('old P');
      expect(readChatDraft(s).text).toBe('live S');
      f.blocked.delete(key); // An unsuccessful envelope must not trigger a now-possible slot retry.
      expect(writeChatDraft(s, 'live S', [])).toBe(false);
      expect(browserReloadText(key)).toBe('old P');
      expect(hasUnsaved()).toBe(true);
      f.blocked.clear();
      expect(writeChatDraft(s, 'live S', [])).toBe(true);
      expect(browserReloadText(key)).toBe('');
      expect(isChatDraftEphemeral()).toBe(false);
      expect(window.localStorage.getItem(envelopeKey)).toContain('live S');
    } finally { f.restore(); clean([p, s]); }
  });

  test('refused non-empty saves keep the latest text, mentions and provenance per key; warning waits for every key', () => {
    const p = identity('/latest-P'), q = identity('/latest-Q'), s = identity('/latest-P', 'S');
    const pk = newSessionSlotKey(p.runtimeKey, p.directory), qk = newSessionSlotKey(q.runtimeKey, q.directory);
    const f = fault();
    try {
      writeChatDraft(p, 'old P', []); writeChatDraft(q, 'old Q', []);
      f.blocked.add(pk); f.blocked.add(qk);
      expect(writeChatDraft(p, 'superseded @old.md', ['old.md'], 40)).toBe(false);
      expect(writeChatDraft(p, 'latest @kept.md', ['kept.md'], 50)).toBe(false);
      expect(writeChatDraft(q, '', [])).toBe(false);
      expect(readChatDraft(p)).toEqual({ text: 'latest @kept.md', confirmedMentions: new Set(['kept.md']) });
      expect(readChatDraftSince(p)).toBe(50);
      writeChatDraft(s, 'retained S', []);
      expect(isChatDraftEphemeral()).toBe(true);
      f.blocked.delete(pk);
      writeChatDraft(s, 'retained S', []);
      expect(window.localStorage.getItem(pk)).toContain('latest @kept.md');
      expect(JSON.parse(window.localStorage.getItem(pk) ?? '{}')).toMatchObject({ confirmedMentions: ['kept.md'], since: 50 });
      expect(browserReloadText(qk)).toBe('old Q');
      expect(isChatDraftEphemeral()).toBe(true);
      f.blocked.clear();
      writeChatDraft(s, 'retained S', []);
      expect(browserReloadText(qk)).toBe('');
      expect(isChatDraftEphemeral()).toBe(false);
      expect(readChatDraft(s).text).toBe('retained S');
    } finally { f.restore(); clean([p, q, s]); }
  });

  test('counterexample: accepted localStorage bytes cannot acknowledge a refused sessionStorage tab ID', () => {
    const backing = window.sessionStorage, set = backing.setItem;
    session.removeItem('openchamber.chatDraftTab');
    backing.setItem = (key, value) => {
      if (key === 'openchamber.chatDraftTab') throw new DOMException('refused', 'SecurityError');
      set.call(backing, key, value);
    };
    const page = createTabDrafts({ storage, session });
    const slot = { text: 'reload needs ID', confirmedMentions: ['id.md'], touchedAt: 1, since: 1 };
    try {
      expect(page.writeSlot('id-1117', '/P', slot)).toBe(false);
      page.retryUnsaved(); // The envelope caller must not acknowledge it either.
      expect(page.hasUnsaved()).toBe(true); // The tab subsystem's warning signal.
      expect(window.localStorage.getItem(page.newSessionSlotKey('id-1117', '/P'))).toContain(slot.text);
      expect(backing.getItem('openchamber.chatDraftTab')).toBeNull();
      backing.setItem = set;
      page.retryUnsaved();
      expect(page.hasUnsaved()).toBe(false);
      // Fresh page, raw browser stores: no safe adapter page-memory on reload.
      expect(createTabDrafts({ storage: window.localStorage, session: backing }).readSlot('id-1117', '/P')).toEqual(slot);
    } finally {
      backing.setItem = set;
      page.writeSlot('id-1117', '/P', undefined);
      session.setItem('openchamber.chatDraftTab', tabId());
      storage.clear();
    }
  });
});
