import { afterAll, afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeComposerDom } from './nativeComposer-dom';

// Storage must bind this window before the composer registers its lifecycle listeners.
const dom = nativeComposerDom();
const { tabId } = await import('@/lib/chatDraftTabs');
const { mountedNativeComposer } = await import('./nativeComposer.fixture');
afterAll(async () => { await dom.restore(); });

// openchamber#433 review 2, P1 1, on the mounted composer: the tab's claim listener runs at pagehide, then the
// composer's own pagehide flush saves the draft again. The page must leave its tab UNCLAIMED, so a fresh tab can take
// the draft over (b6e7afa8: the flush's tabId() wrote the claim back).
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

test('closing a tab with a typed New session draft leaves its tab unclaimed after the composer\'s unload save', async () => {
  const c = mounted = await mountedNativeComposer(true, dom);
  const id = tabId(); // The tab's claim listener is registered here, before the composer's flush listener.
  await act(async () => { c.remount(); await sleep(20); });
  await c.replace('alpha before close'); await act(async () => { await sleep(700); });
  expect(c.dom.window.localStorage.getItem(`openchamber.chatDraftTabClaim:${id}`)).not.toBeNull();
  await act(async () => { c.dom.window.dispatchEvent(new c.dom.window.Event('pagehide')); await sleep(20); });
  expect(c.dom.window.localStorage.getItem(`openchamber.chatDraftTabClaim:${id}`)).toBeNull();
  const slot = [...Array(c.dom.window.localStorage.length).keys()].map(i => c.dom.window.localStorage.key(i)!).find(k => k.startsWith('openchamber.chatDraftSlot:') && k.includes(id));
  expect(c.dom.window.localStorage.getItem(slot ?? '') ?? '').toContain('alpha before close');
  c.dom.window.dispatchEvent(Object.assign(new c.dom.window.Event('pageshow'), { persisted: true }) as never); // Back for the next tests.
});
