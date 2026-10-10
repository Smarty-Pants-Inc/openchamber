import { expect, test } from 'bun:test';
import './durableStorage.testing';
import { consumeChatDraft, isChatDraftEphemeral, readChatDraft, writeChatDraft } from './chatDraftPersistence';
import { createTabDrafts, newSessionSlotKey } from './chatDraftTabs';
import { getSafeStorage } from '@/stores/utils/safeStorage';

const envelopeKey = 'openchamber.chatDrafts.v2';
const storage = getSafeStorage();

for (const cleanupRefused of [false, true]) {
  test(`legacy consumption survives S-only recovery and raw reload (cleanup refused=${cleanupRefused})`, () => {
    const p = { runtimeKey: 'legacy-envelope-1117', directory: `/P-${cleanupRefused}`, sessionId: null };
    const s = { ...p, sessionId: 'S' };
    const key = newSessionSlotKey(p.runtimeKey, p.directory);
    const legacyKey = JSON.stringify([p.runtimeKey, p.directory, null]);
    const backing = window.localStorage, set = backing.setItem, remove = backing.removeItem;
    let slotsRefused = true, recovering = false, envelopeWrites = 0;
    storage.setItem(envelopeKey, JSON.stringify({ version: 2, drafts: {
      [legacyKey]: { text: 'delivered legacy', confirmedMentions: ['sent.md'], touchedAt: 10, since: 10 },
    } }));
    backing.setItem = (k, value) => {
      if (slotsRefused && k === key) throw new DOMException('refused slot', 'SecurityError');
      if (recovering && k === envelopeKey && ++envelopeWrites > 1 && cleanupRefused) {
        throw new DOMException('refused cleanup', 'SecurityError');
      }
      set.call(backing, k, value);
    };
    backing.removeItem = k => {
      if ((slotsRefused && k === key) || (recovering && cleanupRefused && k === envelopeKey)) {
        throw new DOMException('refused removal', 'SecurityError');
      }
      remove.call(backing, k);
    };
    try {
      expect(readChatDraft(p).text).toBe('delivered legacy'); // Migration is memory-only.
      expect(consumeChatDraft(p, 'delivered legacy', 20)).toBe(true);
      expect(writeChatDraft(s, 'next unsent S', [], 30)).toBe(true);
      expect(isChatDraftEphemeral()).toBe(true);
      slotsRefused = false; recovering = true;
      writeChatDraft(s, 'next unsent S', [], 30);
      const reload = createTabDrafts({ storage: backing, session: window.sessionStorage });
      expect(reload.readSlot(p.runtimeKey, p.directory)).toBeUndefined();
      // Even a refused envelope cleanup cannot let its retained legacy text replace the durable clear.
      const legacy = JSON.parse(backing.getItem(envelopeKey) ?? '{}').drafts?.[legacyKey];
      reload.adoptLegacy(p.runtimeKey, p.directory, legacy);
      expect(reload.readSlot(p.runtimeKey, p.directory)).toBeUndefined();
      expect(isChatDraftEphemeral()).toBe(cleanupRefused);
      recovering = false;
      expect(writeChatDraft(s, 'next unsent S', [], 30)).toBe(true);
      expect(JSON.parse(backing.getItem(envelopeKey) ?? '{}').drafts[legacyKey]).toBeUndefined();
      expect(isChatDraftEphemeral()).toBe(false);
      expect(readChatDraft(s).text).toBe('next unsent S');
      expect(readChatDraft(p).text).toBe('');
    } finally {
      backing.setItem = set; backing.removeItem = remove;
      writeChatDraft(p, '', []); writeChatDraft(s, '', []); storage.clear();
    }
  });
}
