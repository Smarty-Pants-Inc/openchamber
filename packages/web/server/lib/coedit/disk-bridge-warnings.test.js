import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createDiskBridge, TEXT, UNWATCHED_NOTICE } from './disk-bridge.js';
import { helperPath } from './safe-file.js';

// Stage beside disk-bridge.test.js. Never build, substitute a helper, or skip these tests.
if (process.platform !== 'linux') throw new Error('#43 requires the real Linux coedit-fs helper');
fs.accessSync(helperPath(), fs.constants.X_OK);
if (process.env.OPENCHAMBER_COEDIT_SOCKET) throw new Error('#43 requires an isolated same-account helper, not a service');
const cleanups = [];
afterEach(async () => {
  const errors = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  vi.restoreAllMocks();
  if (errors.length) throw new AggregateError(errors, '#43 cleanup failed');
});
const poll = (read) => expect.poll(read, { timeout: 5000 });
const snapshot = (bridge) => structuredClone(bridge.state());

const setup = async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-43-')));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'project');
  fs.mkdirSync(root);
  const file = path.join(root, 'f.md');
  fs.writeFileSync(file, 'a');
  const doc = new Y.Doc();
  const text = doc.getText(TEXT);
  const hooks = {};
  const made = [];
  const conflicts = [];
  let restart = false;
  // Real watchers; suppress native change delivery to isolate saves from automatic sync.
  // Restart catch-up still uses the bridge's own syncFor and real helper reads.
  const watch = (dir) => {
    if (made.length && !restart) throw new Error('ENOSPC: test denies another watcher');
    const watcher = fs.watch(dir, () => {});
    made.push(watcher);
    return watcher;
  };
  const bridge = createDiskBridge({ root, file, doc, hooks, watch, recoveryDir: path.join(home, 'recovery'),
    enabled: true, settleMs: 37, retryMs: 100, retryLimit: 600, closeMs: 5000,
    onConflict: (found) => conflicts.push(found) });
  cleanups.push(async () => {
    try { expect(await bridge.close()).toEqual({ quiescent: true }); }
    finally { for (const watcher of made) watcher.close(); doc.destroy(); }
  });
  await bridge.load();
  return { file, text, hooks, made, bridge, conflicts, resume: () => { restart = true; }, block: () => { restart = false; },
    stop: () => made.at(-1).emit('error', new Error('EMFILE: test stops observation')),
    disk: () => fs.readFileSync(file, 'utf8') };
};

// Local #481 pattern: delay exactly one settled-read gap AFTER a real helper read.
// No file operation, helper request, or reply is fabricated.
const readGap = () => {
  const native = globalThis.setTimeout;
  let armed = false;
  let release = () => {};
  let entered = false;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((done, ms, ...args) => {
    if (!armed || ms !== 37) return native(done, ms, ...args);
    armed = false;
    const handle = native(() => {}, 10_000);
    release = () => { clearTimeout(handle); release = () => {}; done(...args); };
    entered = true;
    return handle;
  });
  cleanups.push(() => release());
  return { arm: () => { armed = true; }, entered: () => poll(() => entered).toBe(true), release: () => release() };
};

const stateIs = (state, refusal, warnings) => {
  expect(state.refusal).toEqual(refusal ? expect.objectContaining({ conflict: refusal }) : null);
  expect(Array.isArray(state.warnings)).toBe(true);
  expect(state.warnings.map((warning) => warning.conflict).sort()).toEqual([...warnings].sort());
  expect(state.conflict).toEqual(state.refusal ?? state.warnings.find((warning) => warning.conflict === warnings.at(-1)) ?? null);
  for (const entry of [state, state.refusal, ...state.warnings, state.conflict].filter(Boolean)) {
    expect(entry).not.toHaveProperty('transient');
    expect(entry).not.toHaveProperty('kept');
  }
};
const raced = async (t) => {
  t.text.insert(0, 'P');
  t.hooks.helper = { pause: 'afterExchange', pauseMs: 3000 };
  const saving = t.bridge.save();
  try { await poll(t.disk).toBe('Pa'); fs.writeFileSync(t.file, 'Qa'); }
  finally { delete t.hooks.helper; }
  const result = await saving;
  expect(result).toMatchObject({ ok: false, conflict: 'raced', published: true });
  expect(fs.readFileSync(result.recovery, 'utf8')).toBe('a');
  fs.writeFileSync(t.file, 'Pa'); // Restore the published base without syncing.
  return result;
};

describe('smartyfs#43 explicit refusal and independent warnings, real helper', () => {
  it('only save sets or clears refusal; authoritative watcher recovery leaves it until a later save', async () => {
    const t = await setup();
    const loaded = snapshot(t.bridge);
    fs.unlinkSync(t.file);
    expect(await t.bridge.save()).toMatchObject({ ok: false, conflict: 'gone' });
    const refused = snapshot(t.bridge);
    t.stop();
    const stopped = snapshot(t.bridge);
    fs.writeFileSync(t.file, 'aX');
    t.resume();
    await poll(() => t.text.toString()).toBe('aX');
    // A same-queue acceptDisk is a barrier, not a sync or save; no hold exists.
    await t.bridge.acceptDisk();
    const recovered = snapshot(t.bridge);
    expect(t.conflicts.map((found) => found.conflict)).toEqual(['gone', 'unwatched']);
    expect(await t.bridge.save()).toEqual({ ok: true });
    stateIs(loaded, null, []);
    stateIs(refused, 'gone', []);
    stateIs(stopped, 'gone', ['unwatched']);
    stateIs(recovered, 'gone', []);
    stateIs(t.bridge.state(), null, []);
  });

  for (const active of [false, true]) it(`P2 W1 delayed recovery: ${active ? 'active owner clears its warning' : 'W2 stopped, stale W1 cannot clear W2 warning'}`, async () => {
    const t = await setup();
    const gap = readGap();
    gap.arm(); t.resume(); t.stop();
    const firstWarning = t.bridge.state().conflict;
    let latestWarning = firstWarning;
    fs.writeFileSync(t.file, 'aX');
    await gap.entered();
    expect(t.made).toHaveLength(2); // W0 stopped, W1 catching up.
    if (!active) {
      t.stop(); // W1 stops while its first real read is held.
      await poll(() => t.made.length).toBe(3); // W2's catch-up queues behind W1.
      t.block(); t.stop(); // W2 stops before W1's delayed completion.
      latestWarning = t.bridge.state().conflict;
      expect(latestWarning).not.toBe(firstWarning);
    }
    gap.release();
    await t.bridge.acceptDisk(); // Drain queued catch-ups, no explicit sync.
    expect(t.text.toString()).toBe(active ? 'aX' : 'a');
    stateIs(t.bridge.state(), null, active ? [] : ['unwatched']);
    if (!active) {
      expect(t.bridge.state().warnings[0]).toEqual(latestWarning);
      expect(latestWarning.notice).toBe(UNWATCHED_NOTICE);
    }
  });

  for (const reason of ['gone', 'changed']) it(`P3 modifying ${reason} refusal clears on verified no-change success, not its raced/watcher warnings`, async () => {
    const t = await setup();
    const recovery = await raced(t);
    t.stop();
    t.text.insert(0, 'Q');
    if (reason === 'gone') fs.unlinkSync(t.file); else fs.writeFileSync(t.file, 'b');
    expect(await t.bridge.save()).toMatchObject({ ok: false, conflict: reason });
    const refused = snapshot(t.bridge);
    t.text.delete(0, 1);
    fs.writeFileSync(t.file, 'Pa');
    const { ino } = fs.statSync(t.file);
    expect(await t.bridge.save()).toEqual({ ok: true });
    expect(await t.bridge.save()).toEqual({ ok: true });
    expect(fs.statSync(t.file).ino).toBe(ino);
    expect(t.disk()).toBe('Pa');
    expect(fs.readFileSync(recovery.recovery, 'utf8')).toBe('a');
    stateIs(refused, reason, ['raced', 'unwatched']);
    stateIs(t.bridge.state(), null, ['raced', 'unwatched']);
    expect(t.bridge.state().warnings.find((warning) => warning.conflict === 'raced').recovery).toBe(recovery.recovery);
  });

  for (const first of ['watcher', 'recovery']) it(`two warnings resolve through their own paths, ${first} first, no explicit sync`, async () => {
    const t = await setup();
    const recovery = await raced(t);
    const published = snapshot(t.bridge);
    t.stop();
    const both = snapshot(t.bridge);
    expect(await t.bridge.save()).toEqual({ ok: true }); // No-change success resolves neither warning.
    const unchanged = snapshot(t.bridge);
    const publish = async () => { t.text.insert(0, 'Q'); expect(await t.bridge.save()).toEqual({ ok: true }); };
    const recover = async () => {
      t.resume(); await poll(() => t.made.length).toBe(2);
      await t.bridge.acceptDisk(); // Barrier behind the replacement's real authoritative read.
    };
    if (first === 'watcher') await recover(); else await publish();
    const one = snapshot(t.bridge);
    if (first === 'watcher') await publish(); else await recover();
    expect(t.disk()).toBe('QPa');
    expect(fs.readFileSync(recovery.recovery, 'utf8')).toBe('a');
    stateIs(published, null, ['raced']);
    stateIs(both, null, ['raced', 'unwatched']);
    stateIs(unchanged, null, ['raced', 'unwatched']);
    stateIs(one, null, [first === 'watcher' ? 'raced' : 'unwatched']);
    stateIs(t.bridge.state(), null, []);
  });
});
