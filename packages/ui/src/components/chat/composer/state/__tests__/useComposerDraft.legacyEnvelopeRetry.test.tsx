import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { nativeComposerDom } from '../../submit/__tests__/nativeComposer-dom';

const dom = nativeComposerDom(), backing = dom.window.localStorage;
let slotsRefused = false;
const envelopeKey = 'openchamber.chatDrafts.v2';
const browserStorage: Storage = {
  getItem: key => backing.getItem(key),
  setItem: (key, value) => {
    if (slotsRefused && key.startsWith('openchamber.chatDraftSlot:')) throw new DOMException('refused', 'SecurityError');
    backing.setItem(key, value);
  },
  removeItem: key => {
    if (slotsRefused && key.startsWith('openchamber.chatDraftSlot:')) throw new DOMException('refused', 'SecurityError');
    backing.removeItem(key);
  },
  clear: () => backing.clear(), key: index => backing.key(index), get length() { return backing.length; },
};
Object.defineProperty(dom.window, 'localStorage', { configurable: true, value: browserStorage });
const { createRoot } = await import('react-dom/client');
const { useComposerDraft } = await import('../useComposerDraft');
const { consumeChatDraft, readChatDraft, writeChatDraft, isChatDraftEphemeral } = await import('@/lib/chatDraftPersistence');
const { createTabDrafts } = await import('@/lib/chatDraftTabs');
const { getSafeStorage } = await import('@/stores/utils/safeStorage');
afterAll(async () => { await dom.restore(); });

for (const end of ['clear', 'confirmed send'] as const) {
  test(`legacy ${end}: P→S transfer cannot replace the pending clear with delivered text`, () => {
    const p = { runtimeKey: 'mounted-legacy-1117', directory: `/P-${end}`, sessionId: null };
    const s = { ...p, sessionId: 'S' };
    const legacyKey = JSON.stringify([p.runtimeKey, p.directory, null]);
    getSafeStorage().setItem(envelopeKey, JSON.stringify({ version: 2, drafts: {
      [legacyKey]: { text: 'delivered legacy', confirmedMentions: [], touchedAt: 10, since: 10 },
    } }));
    slotsRefused = true;
    const initial = readChatDraft(p).text;
    expect(initial).toBe('delivered legacy');
    const messageRef = { current: initial }, confirmedMentionsRef = { current: new Set<string>() };
    let change: (text: string) => void = () => { throw new Error('not mounted'); };
    function Composer({ materialized }: { materialized: boolean }) {
      const [message, setMessage] = React.useState(initial);
      change = text => { messageRef.current = text; setMessage(text); };
      const controls = useComposerDraft({
        message, messageRef, setMessage: change, confirmedMentionsRef,
        identity: materialized ? s : p, materializedSessionId: materialized ? 'S' : null,
        persistEnabled: true, initialDraft: { text: initial, identity: p },
      });
      return <output data-memory-only={controls.ephemeralOnly}>{message}</output>;
    }
    const root = createRoot(dom.container);
    const flush = () => act(() => window.dispatchEvent(new Event('pagehide')));
    try {
      act(() => root.render(<Composer materialized={false} />));
      if (end === 'clear') { act(() => change('')); flush(); }
      else act(() => { expect(consumeChatDraft(p, initial)).toBe(true); });
      expect(messageRef.current).toBe('');
      act(() => change('next unsent in S'));
      act(() => root.render(<Composer materialized />));
      flush();
      expect(isChatDraftEphemeral()).toBe(true);
      slotsRefused = false;
      flush(); // Now ONLY S owns the lifecycle flush.
      const reload = createTabDrafts({ storage: backing, session: dom.window.sessionStorage });
      expect(reload.readSlot(p.runtimeKey, p.directory)).toBeUndefined();
      expect(JSON.parse(backing.getItem(envelopeKey) ?? '{}').drafts[legacyKey]).toBeUndefined();
      expect(readChatDraft(p).text).toBe('');
      expect(readChatDraft(s).text).toBe('next unsent in S');
      expect(dom.container.textContent).toBe('next unsent in S');
      expect(isChatDraftEphemeral()).toBe(false);
    } finally {
      slotsRefused = false;
      act(() => root.unmount());
      writeChatDraft(p, '', []); writeChatDraft(s, '', []); getSafeStorage().clear();
    }
  });
}
