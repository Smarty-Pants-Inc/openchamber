import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Window as ReadWindow } from '../lib/windowQueue';

// smarty-code#583 (dry run on served 3.59, 5910149544; candidate 11:3xZ): a placeholder taller than the view stays
// intersecting while the reader wheels through it, so its IntersectionObserver never fires again and the window at the
// reader's new place is never read: the list stayed blank. Scrolling within it must read the window where the reader is.
const happy = new Window({ width: 1200, height: 800 }); const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document, IntersectionObserver: g.IntersectionObserver, HTMLElement: g.HTMLElement };
let observed: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
Object.assign(g, { window: happy, document: happy.document, HTMLElement: happy.HTMLElement,
  IntersectionObserver: class { constructor(cb: (e: { isIntersecting: boolean }[]) => void) { observed = cb; } observe() {} disconnect() {} } });
const { GapRow } = await import('./GapRow');
afterEach(() => { Object.assign(g, saved); });

test('a tall placeholder in view reads the window at the reader\'s place as the list scrolls, not only when it first shows', async () => {
  const scroller = happy.document.createElement('div'); scroller.setAttribute('data-scrollbar', 'chat'); happy.document.body.appendChild(scroller);
  // The view is 0..800 px; the placeholder spans the whole gap (1,000..9,000 records at 80 px each).
  (scroller as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ top: 0, bottom: 800 });
  let top = -600_000; // Where the placeholder's top sits relative to the view: scrolling up moves it down.
  const reads: ReadWindow[][] = [];
  const gap = { kind: 'gap' as const, key: 'gap:1000', start: 1_000, end: 9_000, gapStart: 1_000, gapEnd: 9_000, heightPx: 640_000 };
  const root = createRoot(scroller as unknown as Element);
  await act(async () => root.render(<GapRow gap={gap} onLoadWindow={(w) => reads.push(w)} />));
  const node = scroller.querySelector('[data-history-gap]') as unknown as { getBoundingClientRect: () => object };
  node.getBoundingClientRect = () => ({ top, bottom: top + 640_000 });
  await act(async () => { observed?.([{ isIntersecting: true }]); await new Promise((r) => setTimeout(r, 150)); });
  expect(reads.length).toBe(1);
  const firstStart = reads[0]![0]!.start;
  // The reader wheels up 40,000 px (about 500 records) while the placeholder stays in view.
  for (let k = 0; k < 20; k++) {
    top += 2_000; scroller.dispatchEvent(new happy.Event('scroll'));
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  expect(reads.length).toBeGreaterThan(1);
  const last = reads.at(-1)![0]!;
  expect(last.start).toBeLessThan(firstStart); // A window further up, where the reader is now.
  await act(async () => root.unmount());
});
