import { afterAll, afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeComposerDom } from './nativeComposer-dom';

// Storage must bind this window before the composer registers its lifecycle listeners.
const dom = nativeComposerDom();
const { getDeferredSafeStorage } = await import('@/stores/utils/safeStorage');
const { isChatDraftEphemeral } = await import('@/lib/chatDraftPersistence');
const { newSessionSlotKey } = await import('@/lib/chatDraftTabs');
const { mountedNativeComposer } = await import('./nativeComposer.fixture');
const { directory } = await import('@/sync/native-draft-fixture');
const { useI18nStore } = await import('@/lib/i18n/store');
// A New session draft is this tab's own key (smarty-code#461).
const slotOf = (c: { runtimeA: string }) => newSessionSlotKey(c.runtimeA, directory);
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => {
  await mounted?.dispose(); mounted = undefined; getDeferredSafeStorage().clear();
  useI18nStore.getState().setLocale('en');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterAll(async () => { await dom.restore(); });

for (const edge of ['pagehide', 'hidden', 'freeze']) {
  test(`final composer edit reaches backing storage before ${edge} dispatch returns`, async () => {
    const c = mounted = await mountedNativeComposer(true, dom);
    await c.replace(`last edit before ${edge}`);
    await c.mention('kept.md');
    const text = c.text();
    expect(dom.window.localStorage.getItem(slotOf(c)) ?? '').not.toContain(text);

    act(() => {
      if (edge === 'hidden') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else if (edge === 'freeze') document.dispatchEvent(new Event('freeze'));
      else window.dispatchEvent(new Event('pagehide'));
      // No await, sleep, adapter read, or timer advancement between dispatch and this assertion.
      expect(JSON.parse(dom.window.localStorage.getItem(slotOf(c)) ?? 'null')).toMatchObject({ text, confirmedMentions: ['kept.md'] });
    });
  });
}

for (const name of ['QuotaExceededError', 'SecurityError']) {
  test(`actual composer retains text and mentions across remount after ${name}`, async () => {
    const c = mounted = await mountedNativeComposer(true, dom);
    const backing = dom.window.localStorage;
    const setItem = backing.setItem, removeItem = backing.removeItem;
    // defineProperty is required by Happy DOM's Storage Proxy; assignment spies are ignored.
    Object.defineProperty(backing, 'setItem', {
      configurable: true, value: () => { throw new DOMException('synthetic write failure', name); },
    });
    Object.defineProperty(backing, 'removeItem', {
      configurable: true, value: () => { throw new DOMException('synthetic remove failure', name); },
    });
    let text = '';
    try {
      await c.replace('live input'); await c.mention('kept.md'); text = c.text();
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
        expect(backing.getItem(slotOf(c)) ?? '').not.toContain(text);
        expect(isChatDraftEphemeral()).toBe(true);
      });
      expect(c.text()).toBe(text);
      expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Draft changes are only in this tab.');
      await act(async () => { c.remount(); });
      expect(c.text()).toBe(text);
      expect(isChatDraftEphemeral()).toBe(true);
      expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Browser storage is unavailable.');
      const editor = c.editor();
      await act(async () => {
        useI18nStore.getState().setLocale('es');
        // The 'es' bundle is a lazy import (real module I/O), not a fixed number of microtasks: wait on a real
        // timer, bounded at 3 s, then assert (20 sleep(0) ticks flaked in the merge queue, OC#178).
        const deadline = Date.now() + 3_000;
        while (useI18nStore.getState().loadingLocale && Date.now() < deadline) await sleep(10);
      });
      expect(useI18nStore.getState().loadingLocale).toBeNull();
      expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Los cambios del borrador');
      expect(c.editor()).toBe(editor);
      expect(c.text()).toBe(text);
    } finally {
      Object.defineProperty(backing, 'setItem', { configurable: true, value: setItem });
      Object.defineProperty(backing, 'removeItem', { configurable: true, value: removeItem });
    }
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
      expect(backing.getItem(slotOf(c))).toContain(text);
      expect(isChatDraftEphemeral()).toBe(false);
    });
    expect(dom.container.querySelector('[role="alert"]')).toBeNull();
    expect(JSON.parse(backing.getItem(slotOf(c)) ?? 'null')).toMatchObject({ text, confirmedMentions: ['kept.md'] });
  });
}
