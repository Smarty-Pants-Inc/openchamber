import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { nativeComposerDom } from '../../submit/__tests__/nativeComposer-dom';
import type { ComposerDraftControls } from '../useComposerDraft';

const dom = nativeComposerDom();
const backing = dom.window.localStorage;
let slotsRefused = false, envelopeRefused = false;
const envelopeKey = 'openchamber.chatDrafts.v2';
// Replace Happy DOM's browser property, not a bound Proxy method. The real safe
// adapter must see BOTH refused setItem and refused fallback removeItem.
const browserStorage: Storage = {
  getItem: key => backing.getItem(key),
  setItem: (key, value) => {
    if ((slotsRefused && key.startsWith('openchamber.chatDraftSlot:')) || (envelopeRefused && key === envelopeKey)) {
      throw new DOMException('refused', 'SecurityError');
    }
    backing.setItem(key, value);
  },
  removeItem: key => {
    if ((slotsRefused && key.startsWith('openchamber.chatDraftSlot:')) || (envelopeRefused && key === envelopeKey)) {
      throw new DOMException('refused', 'SecurityError');
    }
    backing.removeItem(key);
  },
  clear: () => backing.clear(), key: index => backing.key(index),
  get length() { return backing.length; },
};
Object.defineProperty(dom.window, 'localStorage', { configurable: true, value: browserStorage });
const { createRoot } = await import('react-dom/client');
const { useComposerDraft } = await import('../useComposerDraft');
const { consumeChatDraft, readChatDraft, writeChatDraft, readChatDraftSince } = await import('@/lib/chatDraftPersistence');
const { newSessionSlotKey, tabId, createTabDrafts } = await import('@/lib/chatDraftTabs');
const { getSafeStorage, getSafeSessionStorage } = await import('@/stores/utils/safeStorage');
afterAll(async () => { await dom.restore(); });

for (const end of ['clear', 'confirmed send'] as const) {
  test(`mounted ${end}: materialize New-session P to S, retry only S on pagehide, reload cannot resurrect P`, () => {
    const p = { runtimeKey: 'mounted-envelope-1117', directory: `/P-${end}`, sessionId: null };
    const s = { ...p, sessionId: 'S' };
    const key = newSessionSlotKey(p.runtimeKey, p.directory);
    getSafeSessionStorage().setItem('openchamber.chatDraftTab', tabId());
    const root = createRoot(dom.container);
    const messageRef = { current: '' }, confirmedMentionsRef = { current: new Set<string>() };
    let controls: ComposerDraftControls | undefined;
    let change: (text: string) => void = () => { throw new Error('not mounted'); };
    function Composer({ materialized }: { materialized: boolean }) {
      const [message, setMessage] = React.useState('');
      change = text => { messageRef.current = text; setMessage(text); };
      controls = useComposerDraft({
        message, messageRef, setMessage: change, confirmedMentionsRef,
        identity: materialized ? s : p, materializedSessionId: materialized ? 'S' : null,
        persistEnabled: true, initialDraft: { text: '', identity: p },
      });
      return <output data-memory-only={controls.ephemeralOnly}>{message}</output>;
    }
    const flush = () => act(() => window.dispatchEvent(new Event('pagehide')));
    try {
      act(() => root.render(<Composer materialized={false} />));
      act(() => { confirmedMentionsRef.current.add('sent.md'); change('delivered @sent.md'); });
      flush();
      expect(backing.getItem(key)).toContain('delivered @sent.md');
      slotsRefused = true;
      if (end === 'clear') { act(() => change('')); flush(); }
      else act(() => { expect(consumeChatDraft(p, 'delivered @sent.md')).toBe(true); });
      expect(messageRef.current).toBe('');
      expect(controls?.ephemeralOnly).toBe(true);
      act(() => { confirmedMentionsRef.current.add('next.md'); change('next in S @next.md'); });
      act(() => root.render(<Composer materialized />));
      flush();
      // S's envelope lands; the outgoing New-session slot still cannot land.
      expect(backing.getItem(envelopeKey)).toContain('next in S @next.md');
      expect(controls?.ephemeralOnly).toBe(true);
      expect(readChatDraft(s).confirmedMentions).toEqual(new Set(['next.md']));
      const since = readChatDraftSince(s);
      expect(since).toBeDefined();
      envelopeRefused = true;
      flush();
      expect(controls?.ephemeralOnly).toBe(true);
      expect(backing.getItem(key)).toContain('delivered @sent.md');
      envelopeRefused = false; slotsRefused = false;
      // No New-session writes from this fixture after recovery. The real hook
      // now owns S, and pagehide must drain P's debt via the envelope path.
      flush();
      const reloaded = createTabDrafts({ storage: backing, session: dom.window.sessionStorage });
      expect(reloaded.tabId()).toBe(tabId());
      expect(reloaded.readSlot(p.runtimeKey, p.directory)).toBeUndefined();
      expect(controls?.ephemeralOnly).toBe(false);
      expect(dom.container.textContent).toBe('next in S @next.md');
      expect(readChatDraft(s)).toEqual({ text: 'next in S @next.md', confirmedMentions: new Set(['next.md']) });
      expect(readChatDraftSince(s)).toBe(since);
      expect(backing.getItem(envelopeKey)).toContain('next in S @next.md');
    } finally {
      slotsRefused = false; envelopeRefused = false;
      act(() => root.unmount());
      writeChatDraft(p, '', []); writeChatDraft(s, '', []);
      getSafeStorage().clear();
    }
  });
}
