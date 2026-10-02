import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { setTimeout as sleep } from 'node:timers/promises';
import { GapRow } from '../components/chat/components/GapRow';
import { createWindowQueue, type Window as ReadWindow } from '../components/chat/lib/windowQueue';
import type { GapEntry } from '../components/chat/lib/turns/renderEntries';
import { ChildStoreManager } from './child-store';
import { SessionMessageLoader } from './session-message-loader';
import type { Range } from './position-windows';
import { record, target } from './session-message-loader-replace.fixture';

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const box = (top: number, height: number): DOMRect => ({ x: 0, y: top, top, bottom: top + height,
  left: 0, right: 1200, width: 1200, height, toJSON: () => ({}) });
const chunk = (start: number): GapEntry => ({ kind: 'gap', key: `gap:${start}`, start, end: start + 100,
  gapStart: 0, gapEnd: 3450, heightPx: 8000 });

for (const jump of [true, false]) {
  test(jump ? 'a scrollbar jump drops the adjacent chunk bundle after one GET and one commit'
    : 'a genuinely uncovered near chunk still loads its directional read-ahead', async () => {
    const happy = new Window({ width: 1200, height: 1000 });
    const observers = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>();
    const globals = { window: happy, document: happy.document, Element: happy.Element, HTMLElement: happy.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      IntersectionObserver: class {
        constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
        observe(node: Element) { observers.set(node, this.callback); }
        disconnect() {}
      } };
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const stores = new ChildStoreManager();
    const started = deferred(), held = deferred();
    const reads: Range[] = [], demands: ReadWindow[][] = [];
    const sdk = createOpencodeClient({ baseUrl: 'https://gap.test', fetch: async input => {
      const request = new Request(input), query = new URL(request.url).searchParams;
      expect(request.method).toBe('GET');
      const start = Number(query.get('at')), end = Math.min(4000, start + Number(query.get('limit')));
      reads.push({ start, end });
      if (start === 1942) { started.resolve(); await held.promise; }
      return Response.json(Array.from({ length: end - start }, (_, i) => record(`m${String(start + i + 1).padStart(5, '0')}`)),
        { headers: { 'x-smarty-at': String(start), 'x-smarty-total': '4000', 'x-smarty-index-epoch': 'e1', 'x-smarty-read-only': '1' } });
    } });
    const loader = new SessionMessageLoader(stores, { sdk, runtimeKey: 'runtime-a' });
    const scroller = document.createElement('div'); scroller.setAttribute('data-scrollbar', 'chat');
    document.body.appendChild(scroller);
    scroller.getBoundingClientRect = () => box(49, 861);
    scroller.scrollTop = 175007;
    const root = createRoot(scroller);
    let commits = 0, publications = 0;
    let stop = () => {}, stopCoverage = () => {};
    try {
      await loader.loadAt(target, 3450, 550);
      expect(loader.getSnapshot(target).positions?.ranges).toEqual([{ start: 3450, end: 4000 }]);
      reads.length = 0;
      const store = stores.getChild(target.directory)!;
      stop = store.subscribe((state, previous) => { if (state.message[target.sessionID] !== previous.message[target.sessionID]) commits++; });
      stopCoverage = loader.subscribe(target, () => { publications++; });
      const queue = createWindowQueue((start, limit) => loader.loadAt(target, start, limit), () => true,
        (trigger: Range) => !loader.getSnapshot(target).positions?.ranges.some(range => range.start <= trigger.start && range.end >= trigger.end));
      const load = (windows: ReadWindow[], trigger?: Range) => { demands.push(windows); queue(windows, trigger); };
      await act(async () => root.render(<>{jump && <GapRow gap={chunk(2100)} onLoadWindow={load} />}
        <GapRow gap={chunk(2200)} onLoadWindow={load} /></>));
      for (const node of scroller.querySelectorAll<HTMLElement>('[data-history-gap]')) {
        const start = Number(node.dataset.historyGap?.split('-')[0]);
        node.getBoundingClientRect = () => box(49 + start * 80 - scroller.scrollTop, 8000);
        observers.get(node)?.([{ isIntersecting: true }]);
      }
      await act(async () => { await sleep(150); });
      if (jump) {
        await started.promise;
        expect(reads).toEqual([{ start: 1942, end: 2442 }]);
        expect(demands).toEqual([[{ start: 1942, limit: 500 }], [{ start: 2200, limit: 500 }, { start: 2700, limit: 500 }]]);
      }
      // Release without any more scroll/observer input. Keep both rows mounted so cleanup cannot protect the queue.
      await act(async () => { held.resolve(); await sleep(250); });
      const expected = jump ? [{ start: 1942, end: 2442 }] : [{ start: 2200, end: 2700 }, { start: 2700, end: 3200 }];
      console.info(`gap ${jump ? 'jump' : 'read-ahead'}: ${JSON.stringify(reads)}, commits=${commits}, coverage publications=${publications}`);
      expect(reads).toEqual(expected);
      expect(commits).toBe(expected.length);
      expect(publications).toBe(expected.length);
      expect(loader.getSnapshot(target).positions?.ranges).toEqual([
        { start: jump ? 1942 : 2200, end: jump ? 2442 : 3200 }, { start: 3450, end: 4000 },
      ]);
    } finally {
      held.resolve(); stop(); stopCoverage(); await act(async () => root.unmount());
      loader.dispose(); stores.disposeAll();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
      await happy.happyDOM.close();
    }
  });
}
