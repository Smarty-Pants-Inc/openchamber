import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function open(page) {
  page.on('pageerror', error => console.log(`FIXTURE ERROR: ${error.stack}`));
  await page.route('**/api/**', route => route.abort());
  await page.goto('/');
  await page.waitForFunction(() => window.scrollFixture && document.querySelector('[data-message-id="live-answer"]'));
  await page.waitForTimeout(1500);
}
async function sample(page, readerId) {
  return page.evaluate(async id => {
    const frames = [];
    let lastTime = performance.now();
    await new Promise(resolve => {
      const read = time => {
        const scroller = document.querySelector('[data-scrollbar="chat"]');
        const box = scroller.getBoundingClientRect();
        const tail = document.querySelector('[data-turn-id="live-user"]');
        const reader = id ? document.querySelector(`[data-turn-id="${id}"]`) : null;
        frames.push({ time, frameGap: time - lastTime, top: scroller.scrollTop, height: scroller.scrollHeight, viewport: scroller.clientHeight,
          bottom: tail ? tail.getBoundingClientRect().bottom - box.bottom : null,
          tailSize: tail?.getBoundingClientRect().height, measuredTailSize: window.scrollFixture.measuredTailSize(),
          reader: reader ? reader.getBoundingClientRect().top - box.top : null, tick: window.scrollFixture.tick });
        lastTime = time;
        // rAF runs before ResizeObserver delivers the virtualizer's sizes.
        // Read after that rendering step, otherwise a corrected pre-paint
        // estimate is wrongly counted as a visible jump.
        if (!window.scrollFixture.done) requestAnimationFrame(nextTime => setTimeout(() => read(nextTime), 0)); else resolve();
      };
      requestAnimationFrame(time => setTimeout(() => read(time), 0));
      window.scrollFixture.start();
    });
    return frames;
  }, readerId);
}
async function evidence(info, frames) {
  const readerExpected = frames.some(frame => frame.reader !== null);
  const effectiveHeight = frame => frame.height - Math.max(0, (frame.measuredTailSize ?? 0) - (frame.tailSize ?? frame.measuredTailSize ?? 0));
  const report = { frames: frames.length, deliveredTicks: frames.at(-1).tick,
    maxFrameGap: Math.max(...frames.map(frame => frame.frameGap)),
    missingTailFrames: frames.filter(frame => frame.bottom === null).length,
    maxBottomError: Math.max(...frames.filter(frame => frame.bottom !== null).map(frame => Math.abs(frame.bottom))),
    bottomJumps: frames.slice(1).filter((frame, i) => frame.bottom !== null && frames[i].bottom !== null && Math.abs(frame.bottom - frames[i].bottom) > 4).length,
    scrollReversals: frames.slice(1).filter((frame, i) => frame.top < frames[i].top - 4).length,
    // A completed tool/reasoning placeholder can shrink. At the bottom the
    // correct scroll delta is the content-height delta, in either direction.
    unexplainedScrollJumps: frames.slice(1).filter((frame, i) => Math.abs((frame.top - frames[i].top) - (effectiveHeight(frame) - effectiveHeight(frames[i]))) > 4).length,
    missingReaderFrames: frames.filter(frame => readerExpected && frame.reader === null).length,
    readerDrift: frames[0].reader === null ? null : Math.max(...frames.map(frame => frame.reader === null ? Infinity : Math.abs(frame.reader - frames[0].reader))),
    contentGrowth: frames.at(-1).height - frames[0].height };
  await writeFile(info.outputPath('metrics.json'), JSON.stringify({ report, samples: frames }, null, 2));
  console.log(`${info.project.name} ${info.title}: ${JSON.stringify(report)}`);
  expect(report.frames).toBeGreaterThan(100);
  expect(report.deliveredTicks).toBe(240);
  expect(report.maxFrameGap).toBeLessThan(250);
  return report;
}

async function viewportMetrics(page, readerId = null) {
  return page.locator('[data-scrollbar="chat"]').evaluate((node, id) => {
    const reader = id ? node.querySelector(`[data-turn-id="${id}"]`) : null;
    const tail = node.querySelector('[data-turn-id="live-user"]');
    return { top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight, width: node.clientWidth,
      tailBottom: tail ? tail.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom : null,
      reader: reader ? reader.getBoundingClientRect().top - node.getBoundingClientRect().top : null,
      tick: window.scrollFixture.tick, messages: window.scrollFixture.messageCount };
  }, readerId);
}
async function heightOnlyResize(page, height, before, fixedContent = true, readerId = null) {
  await page.setViewportSize({ width: page.viewportSize().width, height });
  await page.waitForTimeout(500);
  const after = await viewportMetrics(page, readerId);
  expect(after.width).toBe(before.width);
  expect(after.viewport).toBe(height);
  if (fixedContent) expect(after.height).toBe(before.height);
  expect(after.tick).toBe(before.tick);
  expect(after.messages).toBe(before.messages);
  return after;
}

// No transcript/data updates during resize: totalSize callbacks cannot mask
// a missing viewport-layout correction. Use idle mode like composer growth.
test('height-only resize keeps the idle end pinned and subsequent streaming visible', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => window.scrollFixture.setWorking(false));
  await page.waitForTimeout(500);
  const before = await viewportMetrics(page);
  expect(before.height).toBeGreaterThan(before.viewport * 2);
  expect(before.tailBottom).not.toBeNull();
  expect(Math.abs(before.tailBottom)).toBeLessThanOrEqual(4);
  const shrunk = await heightOnlyResize(page, before.viewport - 240, before);
  const grown = await heightOnlyResize(page, before.viewport + 100, before);
  await writeFile(info.outputPath('resize.json'), JSON.stringify({ before, shrunk, grown }, null, 2));
  console.log(`${info.project.name} pinned height-only resize: ${JSON.stringify({ before, shrunk, grown })}`);
  expect(shrunk.tailBottom).not.toBeNull();
  expect(grown.tailBottom).not.toBeNull();
  expect.soft(Math.abs(shrunk.tailBottom)).toBeLessThanOrEqual(4);
  expect.soft(Math.abs(grown.tailBottom)).toBeLessThanOrEqual(4);
  await page.evaluate(() => window.scrollFixture.setWorking(true));
  const report = await evidence(info, await sample(page));
  expect(report.contentGrowth).toBeGreaterThan(500);
  expect(report.missingTailFrames).toBe(0);
  expect(report.maxBottomError).toBeLessThanOrEqual(4);
});

test('height-only resize preserves scrollback until the reader explicitly returns to latest', async ({ page }, info) => {
  await open(page);
  await page.mouse.move(180, 200);
  await page.mouse.wheel(0, -2200);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.scrollFixture.userOwnsScroll)).toBe(true);
  const readerId = await page.locator('[data-scrollbar="chat"]').evaluate(node =>
    [...node.querySelectorAll('[data-turn-id]')].find(row => row.getBoundingClientRect().top >= node.getBoundingClientRect().top)?.dataset.turnId);
  expect(readerId).toBeTruthy();
  const before = await viewportMetrics(page, readerId);
  const shrunk = await heightOnlyResize(page, before.viewport - 240, before, false, readerId);
  const grown = await heightOnlyResize(page, before.viewport + 100, before, false, readerId);
  // Newly mounted virtualized rows may settle estimates. The visible row and
  // offset, not an uncompensated absolute scrollTop, identify the reader's place.
  expect(shrunk.reader).not.toBeNull();
  expect(grown.reader).not.toBeNull();
  expect(Math.abs(shrunk.reader - before.reader)).toBeLessThanOrEqual(4);
  expect(Math.abs(grown.reader - before.reader)).toBeLessThanOrEqual(4);
  await page.evaluate(() => window.scrollFixture.start());
  await page.waitForFunction(() => window.scrollFixture.done);
  const streamed = await viewportMetrics(page, readerId);
  expect(streamed.reader).not.toBeNull();
  expect(Math.abs(streamed.reader - before.reader)).toBeLessThanOrEqual(4);
  // Explicit latest is the only point where resize may take ownership again.
  await page.evaluate(() => window.scrollFixture.latest());
  await page.waitForTimeout(1200);
  const latest = await viewportMetrics(page);
  const repinned = await heightOnlyResize(page, before.viewport - 240, latest);
  await writeFile(info.outputPath('resize.json'), JSON.stringify({ before, shrunk, grown, streamed, latest, repinned }, null, 2));
  console.log(`${info.project.name} reader height-only resize: ${JSON.stringify({ before, shrunk, grown, streamed, latest, repinned })}`);
  expect(repinned.tailBottom).not.toBeNull();
  expect(Math.abs(repinned.tailBottom)).toBeLessThanOrEqual(4);
});

test('follows streaming bottom without frame jumps', async ({ page }, info) => {
  await open(page);
  const frames = await sample(page);
  const report = await evidence(info, frames);
  expect(report.contentGrowth).toBeGreaterThan(500);
  expect(report.missingTailFrames).toBe(0);
  expect(report.maxBottomError).toBeLessThanOrEqual(4);
  expect(report.bottomJumps).toBe(0);
  expect(report.unexplainedScrollJumps).toBe(0);
});

for (const withGap of [false, true]) test(`reader stays put during updates and ${withGap ? 'large-gap ' : ''}positions remount`, async ({ page }, info) => {
  await open(page);
  await page.mouse.move(180, 200);
  await page.mouse.wheel(0, -2200);
  await page.waitForTimeout(800);
  const readerId = await page.evaluate(() => {
    const scroller = document.querySelector('[data-scrollbar="chat"]');
    const top = scroller.getBoundingClientRect().top;
    return [...scroller.querySelectorAll('[data-turn-id]')].find(row => row.getBoundingClientRect().top >= top)?.dataset.turnId;
  });
  expect(readerId).toBeTruthy();
  expect(await page.evaluate(() => window.scrollFixture.userOwnsScroll)).toBe(true);
  const pending = sample(page, readerId);
  await page.waitForTimeout(2000);
  await page.evaluate(gap => window.scrollFixture.remount(gap), withGap);
  const report = await evidence(info, await pending);
  expect(report.missingReaderFrames).toBe(0);
  expect(report.readerDrift).toBeLessThanOrEqual(4);
});

test('follow survives positions remount', async ({ page }, info) => {
  await open(page);
  const pending = sample(page);
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollFixture.remount());
  const report = await evidence(info, await pending);
  expect(report.missingTailFrames).toBe(0);
  expect(report.maxBottomError).toBeLessThanOrEqual(4);
  expect(report.bottomJumps).toBe(0);
});

test('beginning and end clamp without phantom blank space', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => { window.scrollFixture.beginning(); window.scrollFixture.start(); });
  await page.waitForTimeout(1000);
  const bounds = async () => page.evaluate(() => {
    const node = document.querySelector('[data-scrollbar="chat"]');
    const box = node.getBoundingClientRect();
    const first = node.querySelector('[data-turn-id="user-0"]');
    const last = node.querySelector('[data-turn-id="live-user"]');
    return { top: node.scrollTop, max: node.scrollHeight - node.clientHeight,
      first: first ? first.getBoundingClientRect().top - box.top : null,
      last: last ? last.getBoundingClientRect().bottom - box.bottom : null,
      overscroll: getComputedStyle(node).overscrollBehaviorY };
  });
  await page.locator('[data-scrollbar="chat"]').evaluate(node => { node.scrollTop = -1000000; });
  await page.mouse.wheel(0, -10000);
  await page.waitForTimeout(500);
  const top = await bounds();
  await page.evaluate(() => { window.scrollFixture.latest(); window.scrollFixture.remount(); });
  await page.waitForFunction(() => window.scrollFixture.done);
  await page.waitForTimeout(300);
  await page.locator('[data-scrollbar="chat"]').evaluate(node => { node.scrollTop = 10000000; });
  await page.mouse.wheel(0, 10000);
  await page.waitForTimeout(500);
  const bottom = await bounds();
  await writeFile(info.outputPath('metrics.json'), JSON.stringify({ top, bottom }, null, 2));
  console.log(`${info.project.name} boundaries: ${JSON.stringify({ top, bottom })}`);
  expect(top.top).toBe(0);
  expect(top.first).not.toBeNull();
  expect(Math.abs(top.first)).toBeLessThanOrEqual(20);
  expect(bottom.top).toBe(bottom.max);
  expect(bottom.last).not.toBeNull();
  expect(Math.abs(bottom.last)).toBeLessThanOrEqual(20);
  expect(top.overscroll).toBe('none');
});

test('auto-follow disabled leaves the streaming viewport untouched', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => window.scrollFixture.setAutoFollow(false));
  await page.waitForTimeout(100);
  const frames = await sample(page);
  const drift = Math.max(...frames.map(frame => Math.abs(frame.top - frames[0].top)));
  await writeFile(info.outputPath('metrics.json'), JSON.stringify({ drift, samples: frames }, null, 2));
  expect(frames.at(-1).tick).toBe(240);
  expect(drift).toBeLessThanOrEqual(4);
});

test('Beginning loads the first positioned window, and reload opens at the end', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => { window.scrollFixture.remount(true); window.scrollFixture.start(); });
  await page.waitForTimeout(500);
  const total = await page.locator('[data-scrollbar="chat"]').evaluate(node => node.scrollHeight);
  expect(total).toBeGreaterThan(1700000);
  await page.evaluate(() => window.scrollFixture.beginning());
  await page.waitForFunction(() => document.querySelector('[data-turn-id="prefix-user-0"]'));
  await page.waitForTimeout(500);
  const beginning = await page.evaluate(() => {
    const node = document.querySelector('[data-scrollbar="chat"]');
    const row = node.querySelector('[data-turn-id="prefix-user-0"]');
    return { scrollTop: node.scrollTop, offset: row.getBoundingClientRect().top - node.getBoundingClientRect().top, reads: window.scrollFixture.gapReads };
  });
  await writeFile(info.outputPath('metrics.json'), JSON.stringify({ total, beginning }, null, 2));
  console.log(`${info.project.name} Beginning: ${JSON.stringify({ total, beginning })}`);
  expect(beginning.reads).toBeGreaterThan(0);
  // Keep these failures fatal to the test, but still collect the independent
  // reload measurement when the unchanged build misses Beginning.
  expect.soft(beginning.scrollTop).toBe(0);
  expect.soft(Math.abs(beginning.offset)).toBeLessThanOrEqual(4);
  await page.reload();
  await page.waitForFunction(() => window.scrollFixture && document.querySelector('[data-turn-id="live-user"]'));
  await page.waitForTimeout(500);
  const reload = await page.evaluate(() => {
    const node = document.querySelector('[data-scrollbar="chat"]');
    const row = node.querySelector('[data-turn-id="live-user"]');
    return { error: row.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom };
  });
  await writeFile(info.outputPath('metrics.json'), JSON.stringify({ total, beginning, reload }, null, 2));
  expect(Math.abs(reload.error)).toBeLessThanOrEqual(4);
});
