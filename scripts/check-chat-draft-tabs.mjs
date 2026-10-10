#!/usr/bin/env bun
// Real-browser regression for chat draft tab isolation when the original tab's
// first native LockManager claim is still pending while a duplicate tab opens.
// Usage: bun scripts/check-chat-draft-tabs.mjs <scratch-dir> [--growth]
// --growth instead opens, drafts in, and closes 50 pages, reporting slot storage growth.
// The scratch directory owns a persistent Chromium profile; nothing is deleted.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPETITIONS = 20;
const TAB_LOCK_PREFIX = 'openchamber.chatDraftTab:';
const SLOT_PREFIX = 'openchamber.chatDraftSlot:';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libDir = path.join(repoRoot, 'packages', 'ui', 'src', 'lib');

const GROWTH_PAGES = 50;
const GROWTH_SNAPSHOTS = new Set([1, 10, 25, 50]);

const [scratchArg, modeArg] = process.argv.slice(2);
if (!scratchArg || (modeArg !== undefined && modeArg !== '--growth')) {
  console.error('usage: bun scripts/check-chat-draft-tabs.mjs <scratch-dir> [--growth]');
  process.exit(2);
}
const growth = modeArg === '--growth';
const profileDir = path.join(path.resolve(scratchArg), growth ? 'growth-profile' : 'browser-profile');
await mkdir(profileDir, { recursive: true });

// One virtual entry imports the real modules once, so the page sees the same
// singleton the persistence layer uses; no second bundle is loaded.
const ENTRY = 'chat-draft-probe-entry';
const entrySource = [
  `import * as tabs from ${JSON.stringify(path.join(libDir, 'chatDraftTabs.ts'))};`,
  `import * as persistence from ${JSON.stringify(path.join(libDir, 'chatDraftPersistence.ts'))};`,
  'export { tabs, persistence };',
].join('\n');
const build = await Bun.build({
  entrypoints: [ENTRY],
  target: 'browser',
  plugins: [{
    name: 'chat-draft-probe-entry',
    setup(builder) {
      builder.onResolve({ filter: new RegExp(`^${ENTRY}$`) }, () => ({ path: ENTRY, namespace: 'probe' }));
      builder.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ contents: entrySource, loader: 'ts', resolveDir: libDir }));
    },
  }],
});
if (!build.success) {
  console.error(JSON.stringify({ ok: false, stage: 'build', logs: build.logs.map(String) }, null, 2));
  process.exit(1);
}
const bundle = await build.outputs[0].text();

const PAGE = '<!doctype html><title>Chat draft tab probe</title><script type="module">'
  + 'window.api=await import("/drafts.js");window.started=true;'
  + 'await window.api.tabs.tabDraftsReady;window.loaded=true;</script>';
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/drafts.js') {
      return new Response(bundle, { headers: { 'content-type': 'text/javascript' } });
    }
    // Same origin, no draft module: reads storage without creating a tab slot.
    if (pathname === '/storage') {
      return new Response('<!doctype html><title>Storage probe</title>', { headers: { 'content-type': 'text/html' } });
    }
    return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
  },
});
const url = `http://127.0.0.1:${server.port}/`;

// Runs in the page before any module: gates only the first load of this tab.
function gateFirstNativeClaim(prefix) {
  if (sessionStorage.getItem('probe-claim-gate-used')) return;
  sessionStorage.setItem('probe-claim-gate-used', '1');
  const manager = navigator.locks;
  const request = manager.request.bind(manager);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  window.releaseClaimGate = () => release();
  window.blockedClaims = 0;
  manager.request = (name, options, callback) => {
    if (String(name).startsWith(prefix)) {
      window.blockedClaims++;
      return gate.then(() => request(name, options, callback));
    }
    return request(name, options, callback);
  };
}

const waitFor = (page, fn) => page.waitForFunction(fn, undefined, { timeout: 5000 });
const write = (page, runtime, text, mention, since) => page.evaluate(({ runtime, text, mention, since }) => {
  const { persistence } = window.api;
  const id = persistence.createChatDraftIdentity(runtime, '/project', null, 1);
  persistence.claimChatDraftOwnership(id);
  return persistence.writeChatDraft(id, text, [mention], since);
}, { runtime, text, mention, since });
const snapshot = (page, runtime) => page.evaluate(({ runtime, prefix }) => {
  const { persistence, tabs } = window.api;
  const saved = persistence.readChatDraft(persistence.createChatDraftIdentity(runtime, '/project', null, 1));
  const slot = tabs.newSessionSlotKey(runtime, '/project');
  return {
    text: saved.text,
    mentions: [...saved.confirmedMentions],
    since: tabs.readSlot(runtime, '/project')?.since,
    slot,
    slotStored: slot.startsWith(prefix) && localStorage.getItem(slot) !== null,
  };
}, { runtime, prefix: SLOT_PREFIX });
const view = ({ text, mentions, since }) => ({ text, mentions, since });
const slotStorage = (page) => page.evaluate((prefix) => {
  const encoder = new TextEncoder();
  let keys = 0;
  let valueBytes = 0;
  let keyValueBytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const value = localStorage.getItem(key) ?? '';
    keys++;
    valueBytes += encoder.encode(value).length;
    keyValueBytes += encoder.encode(key).length + encoder.encode(value).length;
  }
  return { slotKeys: keys, valueUtf8Bytes: valueBytes, keyPlusValueUtf8Bytes: keyValueBytes };
}, SLOT_PREFIX);

async function runGrowth(context) {
  const points = [];
  let closed = 0;
  for (let index = 0; index < GROWTH_PAGES; index++) {
    const page = await context.newPage();
    await page.goto(url);
    await waitFor(page, () => window.loaded);
    const label = `draft-${String(index).padStart(2, '0')}`;
    await write(page, 'growth', `${label} @file.ts`, 'file.ts', 1000 + index);
    await page.close();
    closed++;
    if (!GROWTH_SNAPSHOTS.has(closed)) continue;
    const probe = await context.newPage();
    await probe.goto(`${url}storage`);
    points.push({ closedPages: closed, ...(await slotStorage(probe)) });
    await probe.close();
  }
  return { closed, points };
}

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  viewport: { width: 900, height: 700 },
});
const pageErrors = [];
const cases = [];
let failure;
// Persistent contexts have no Browser handle, so read the version from a page.
let browserVersion = context.browser()?.version() ?? null;
let growthResult;
try {
  context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
  if (growth) {
    const probe = await context.newPage();
    await probe.goto(`${url}storage`);
    browserVersion ??= await probe.evaluate(() => /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null);
    await probe.close();
    growthResult = await runGrowth(context);
  }
  for (let run = 0; !growth && run < REPETITIONS; run++) {
    const runtime = `isolation-${run}`;
    const forcedPagehide = run % 2 === 1;
    const original = await context.newPage();
    await original.addInitScript(gateFirstNativeClaim, TAB_LOCK_PREFIX);
    await original.goto(url);
    await waitFor(original, () => window.started);
    browserVersion ??= await original.evaluate(() => /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null);
    assert.ok(await original.evaluate(() => window.blockedClaims > 0), `case ${run + 1}: native claim was not gated`);
    assert.equal(await original.evaluate(() => window.loaded === true), false, `case ${run + 1}: claim granted before release`);

    await write(original, runtime, 'source @source.ts', 'source.ts', 5);
    if (forcedPagehide) await original.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const popup = context.waitForEvent('page');
    await original.evaluate(() => { window.open('/', '_blank'); });
    const child = await popup;
    await waitFor(child, () => window.loaded);
    await write(child, runtime, 'copy @copy.ts', 'copy.ts', 15);
    await write(original, runtime, 'owner newer @owner.ts', 'owner.ts', 25);
    await original.evaluate(() => window.releaseClaimGate());
    await waitFor(original, () => window.loaded);

    const a = await snapshot(original, runtime);
    const b = await snapshot(child, runtime);
    assert.deepEqual(view(a), { text: 'owner newer @owner.ts', mentions: ['owner.ts'], since: 25 }, `case ${run + 1}: original`);
    assert.deepEqual(view(b), { text: 'copy @copy.ts', mentions: ['copy.ts'], since: 15 }, `case ${run + 1}: child`);
    assert.notEqual(a.slot, b.slot, `case ${run + 1}: shared storage key`);
    assert.ok(a.slotStored && b.slotStored, `case ${run + 1}: slot not stored under own key`);

    await original.reload();
    await waitFor(original, () => window.started && window.loaded);
    await child.reload();
    await waitFor(child, () => window.started && window.loaded);
    assert.deepEqual(view(await snapshot(original, runtime)), view(a), `case ${run + 1}: original after reload`);
    assert.deepEqual(view(await snapshot(child, runtime)), view(b), `case ${run + 1}: child after reload`);

    await original.evaluate((rt) => {
      const { persistence } = window.api;
      const id = persistence.createChatDraftIdentity(rt, '/project', null, 1);
      persistence.claimChatDraftOwnership(id);
      persistence.writeChatDraft(id, '', []);
    }, runtime);
    assert.equal((await snapshot(original, runtime)).text, '', `case ${run + 1}: original not cleared`);
    assert.deepEqual(view(await snapshot(child, runtime)), view(b), `case ${run + 1}: clear leaked into child`);

    await original.close();
    await child.close();
    cases.push({ case: run + 1, gatedFirstNativeClaim: true, forcedPagehideBeforeOpener: forcedPagehide, result: 'PASS' });
  }
  assert.deepEqual(pageErrors, [], 'page errors');
} catch (error) {
  failure = error;
} finally {
  await context.close();
  server.stop(true);
  const summary = growth ? {
    ok: !failure,
    browser: `chromium ${browserVersion ?? 'unknown'}`,
    mode: 'growth',
    actualClosedPages50: growthResult?.closed === GROWTH_PAGES,
    actualClosedPages: growthResult?.closed ?? 0,
    growthPoints: growthResult?.points ?? [],
    pruning: 'none',
    signedInApplication: 'not exercised',
  } : {
    ok: !failure,
    browser: `chromium ${browserVersion ?? 'unknown'}`,
    repetitions: REPETITIONS,
    completed: cases.length,
    forcedLifecycleCount: cases.filter((entry) => entry.forcedPagehideBeforeOpener).length,
    cases,
    signedInApplication: 'not exercised',
  };
  if (failure) {
    summary.error = failure instanceof Error ? failure.message : String(failure);
    summary.pageErrors = pageErrors;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (failure) process.exitCode = 1;
}
