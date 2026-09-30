import { execFileSync, spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { createDiskBridge, DISK_ORIGIN, TEXT } from './disk-bridge.js';
import { collectRecovered, hashBytes, keyOf, publish, readFile, startHelper, tokenCount } from './safe-file.js';
import { ensureHelper } from './fs-helper/ensure-built.js';

ensureHelper(); // The bridge runs only through the built helper.

process.env.OPENCHAMBER_COEDIT_SAME_ACCOUNT = '1'; // Tests run the helper as themselves; production uses the service (smartyfs#32).
process.env.COEDIT_FS_TEST = '1'; // The helper honours a test pause or fault only with this (smartyfs#32).
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The pids of coedit-fs processes (real or fake) started for `root`. */
const helperPids = (root) => fs.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return args.includes(root) && args.some((arg) => arg.endsWith('coedit-fs'));
  } catch {
    return false;
  }
}).map(Number);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
  } catch {
    return false;
  }
};
const killHelper = (root) => {
  const pids = helperPids(root);
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) process.kill(pid, 'SIGKILL');
};

/** A real project and file, a recovery directory outside it, and a room bridged to the file. */
const setup = async (content = 'hello world\n', { watch = false, retryMs = 50 } = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
  const root = path.join(home, 'project');
  const recoveryDir = path.join(home, 'recovery');
  const privateDir = path.join(recoveryDir, '.staging');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const file = path.join(root, 'src', 'notes.md');
  fs.writeFileSync(file, content);
  const hooks = {};
  /** A bridge for the file with its own room and conflicts (a restart makes a second one). */
  const open = (extra = {}) => {
    const doc = new Y.Doc();
    const conflicts = [];
    const options = { root, file, doc, recoveryDir, hooks, debounceMs: 10, settleMs: 20, retryMs, onConflict: (c) => conflicts.push(c), enabled: true, ...extra };
    if (!watch) options.watch = () => ({ close() {} });
    const bridge = createDiskBridge(options);
    cleanups.unshift(() => void bridge.close());
    return { bridge, doc, conflicts, text: doc.getText(TEXT) };
  };
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const { bridge, doc, conflicts, text } = open();
  await bridge.load();
  /** A person's edit in the room (another client's Y.Doc, synced in). */
  const person = (edit) => {
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(other);
    edit(other.getText(TEXT));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, before), 'person');
  };
  /** The helper's private staging entries (displaced or staged revisions). */
  const staged = () => (fs.existsSync(privateDir) ? fs.readdirSync(privateDir).filter((n) => !n.endsWith('-lock') && !n.endsWith('.txn') && !n.endsWith('.out') && !n.endsWith('.done')) : []);
  /** Saves with the helper paused at `point`, running `fn` inside that window. */
  const saveDuring = async (point, fn) => {
    hooks.helper = { pause: point, pauseMs: 3000 };
    const saving = bridge.save();
    // At its window: the staged entry exists before the exchange; before the open there is nothing to see, so wait.
    for (let i = 0; i < 100 && (point !== 'beforeExchange' || staged().length === 0); i += 1) await sleep(point === 'beforeExchange' ? 20 : 10);
    await fn();
    try {
      return await saving;
    } finally {
      delete hooks.helper;
    }
  };
  /** Anything in the project besides the file, and anything left in the private directory. */
  const leftovers = () => [...fs.readdirSync(path.dirname(file)).filter((entry) => entry !== 'notes.md'), ...staged()];
  const kept = () => (fs.existsSync(recoveryDir) ? fs.readdirSync(recoveryDir, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => fs.readFileSync(path.join(recoveryDir, f.name), 'utf8')) : []);
  return { home, root, file, doc, text, bridge, hooks, open, person, saveDuring, conflicts, staged, leftovers, kept, recoveryDir, privateDir, disk: () => fs.readFileSync(file, 'utf8') };
};

/** A stand-in coedit-fs: a small node script (OPENCHAMBER_COEDIT_FS points to it). */
const fakeHelper = (body) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-fake-')));
  const script = path.join(dir, 'coedit-fs');
  fs.writeFileSync(script, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  const saved = process.env.OPENCHAMBER_COEDIT_FS;
  process.env.OPENCHAMBER_COEDIT_FS = script;
  cleanups.push(() => {
    if (saved === undefined) delete process.env.OPENCHAMBER_COEDIT_FS;
    else process.env.OPENCHAMBER_COEDIT_FS = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { root: dir, privateDir: path.join(dir, 'private') };
};
const SILENT = 'process.stdin.resume(); setInterval(() => {}, 1000);';

describe('co-edit disk bridge (smartyfs#18)', () => {
  it('loads the file into the room', async () => {
    const { text, bridge } = await setup('line one\nline two\n');
    expect(text.toString()).toBe('line one\nline two\n');
    expect(bridge.state()).toEqual({ gone: false, loaded: true, conflict: null });
  });

  it('merges an outside write into the room as a minimal edit, keeping what people typed meanwhile', async () => {
    const { text, file, bridge, person, doc } = await setup('hello world\n');
    person((t) => t.insert(0, 'Paul: '));
    fs.writeFileSync(file, 'hello brave world\n'); // The agent's write, from the text it read.
    const origins = [];
    doc.on('update', (_u, origin) => origins.push(origin));
    await bridge.sync();
    expect(text.toString()).toBe('Paul: hello brave world\n');
    expect(origins).toEqual([DISK_ORIGIN]);
  });

  it('saves the room to disk; the replaced revision is kept for recovery; nothing is left behind', async () => {
    const t = await setup('a\n');
    t.person((x) => x.insert(1, 'b'));
    expect(await t.bridge.save()).toEqual({ ok: true });
    expect(t.disk()).toBe('ab\n');
    expect(t.kept().sort()).toEqual(['a\n', 'ab\n']); // The replaced revision, and ours.
    expect(fs.statSync(t.recoveryDir).mode & 0o777).toBe(0o700);
    await t.bridge.sync();
    expect(t.text.toString()).toBe('ab\n');
    expect(t.leftovers()).toEqual([]);
  });

  it('a save over a file changed since the last read is a visible conflict: nothing written, the base kept', async () => {
    const t = await setup('one\ntwo\n');
    t.person((x) => x.insert(0, 'zero\n'));
    fs.writeFileSync(t.file, 'one\ntwo\nthree\n'); // An agent, not yet seen by the room.
    expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'changed' });
    expect(t.disk()).toBe('one\ntwo\nthree\n');
    expect(t.conflicts.map((c) => c.conflict)).toEqual(['changed']);
    expect(t.bridge.state().conflict.conflict).toBe('changed');
    await t.bridge.sync(); // The room shows theirs merged with ours; the person saves again.
    expect(await t.bridge.save()).toEqual({ ok: true });
    expect(t.disk()).toBe('zero\none\ntwo\nthree\n');
    expect(t.bridge.state().conflict).toBe(null);
  });

  describe('the atomic helper (smartyfs#32 design 5879185733): each residual at its exact window', () => {
    it('a delete just before the exchange is a conflict: the file is not recreated, nothing is left behind', async () => {
      const t = await setup('base\n');
      t.person((x) => x.insert(0, 'person\n'));
      const result = await t.saveDuring('beforeExchange', () => fs.unlinkSync(t.file));
      expect(result).toMatchObject({ ok: false, conflict: 'gone' });
      expect(fs.existsSync(t.file)).toBe(false); // A deleted file is never recreated (residual 2).
      expect(t.leftovers()).toEqual([]);
      expect(t.text.toString()).toBe('person\nbase\n'); // The room keeps the person's text.
    });

    it('a replace by rename just before the exchange: ours is published, never undone; theirs is kept for recovery and shown (raced)', async () => {
      const t = await setup('base\n');
      t.person((x) => x.insert(0, 'person\n'));
      const result = await t.saveDuring('beforeExchange', () => {
        fs.writeFileSync(`${t.file}.git`, 'base\ncheckout\n');
        fs.renameSync(`${t.file}.git`, t.file);
      });
      expect(result).toMatchObject({ ok: false, conflict: 'raced', published: true });
      expect(fs.readFileSync(result.recovery, 'utf8')).toBe('base\ncheckout\n');
      expect(t.disk()).toBe('person\nbase\n');
      await t.bridge.sync();
      expect(t.text.toString()).toBe('person\nbase\n'); // The base followed ours: no replay.
      expect(t.leftovers()).toEqual([]);
    });

    it('an in-place write just before the exchange: ours is published, theirs is kept for recovery and shown (raced)', async () => {
      const t = await setup('base\n');
      t.person((x) => x.insert(0, 'person\n'));
      const result = await t.saveDuring('beforeExchange', () => fs.appendFileSync(t.file, 'agent\n'));
      expect(result).toMatchObject({ ok: false, conflict: 'raced' });
      expect(result.notice).toMatch(/check the recovery folder/);
      expect(fs.readFileSync(result.recovery, 'utf8')).toBe('base\nagent\n');
      expect(t.disk()).toBe('person\nbase\n');
      await t.bridge.sync();
      expect(t.text.toString()).toBe('person\nbase\n'); // The base followed ours: no replay.
      expect(t.leftovers()).toEqual([]);
    });

    it('staging never appears in the project: it lives in the 0700 private directory (review: staging substitution)', async () => {
      const t = await setup('original\n');
      t.person((x) => x.insert(0, 'person\n'));
      let during = null;
      const result = await t.saveDuring('beforeExchange', () => {
        during = { project: fs.readdirSync(path.dirname(t.file)), staged: t.staged(), mode: fs.statSync(t.privateDir).mode & 0o777 };
      });
      expect(result).toEqual({ ok: true });
      expect(during.project).toEqual(['notes.md']);
      expect(during.staged).toHaveLength(1);
      expect(during.staged[0].startsWith(`${keyOf(t.root, 'src/notes.md')}.`)).toBe(true);
      expect(during.mode).toBe(0o700);
      expect(t.leftovers()).toEqual([]);
    });

    it('a write through an old descriptor after the save lands in the displaced revision: kept, and shown once written (residual 4)', async () => {
      const t = await setup('log\n', { retryMs: 60_000 });
      const agentFd = fs.openSync(t.file, 'a'); // An agent holding the file open for appends.
      t.person((x) => x.insert(0, 'person\n'));
      expect(await t.bridge.save()).toEqual({ ok: true }); // Published; the displaced revision is kept while it is open.
      expect(t.staged()).toHaveLength(1);
      expect(fs.readdirSync(path.dirname(t.file))).toEqual(['notes.md']);
      fs.writeSync(agentFd, 'appended\n');
      fs.closeSync(agentFd);
      await t.bridge.sync();
      const raced = t.conflicts.at(-1);
      expect(raced).toMatchObject({ conflict: 'raced' });
      expect(fs.readFileSync(raced.recovery, 'utf8')).toBe('log\nappended\n');
      expect(t.disk()).toBe('person\nlog\n');
      expect(t.text.toString()).toBe('person\nlog\n'); // Not replayed.
      expect(t.leftovers()).toEqual([]);
    });

    it('a late write with the real watcher: the writer closes, and with no sync or other write it is kept and shown (review: late writes)', async () => {
      const t = await setup('log\n', { watch: true });
      const agentFd = fs.openSync(t.file, 'a');
      t.person((x) => x.insert(0, 'person\n'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.staged()).toHaveLength(1); // Pending: the writer still has it open.
      await sleep(300); // The watcher's sync after the publish has run, with the writer still open.
      fs.writeSync(agentFd, 'appended\n');
      fs.closeSync(agentFd);
      await expect.poll(() => t.conflicts.find((c) => c.conflict === 'raced'), { timeout: 5000 }).toBeTruthy();
      const raced = t.conflicts.find((c) => c.conflict === 'raced');
      expect(raced.notice).toMatch(/check the recovery folder/);
      expect(fs.readFileSync(raced.recovery, 'utf8')).toBe('log\nappended\n');
      expect(t.disk()).toBe('person\nlog\n');
      expect(t.text.toString()).toBe('person\nlog\n');
      expect(t.leftovers()).toEqual([]);
    });

    it('a restart with the writer still open: load enrolls the revision in pending and collects it later on its own', async () => {
      const t = await setup('log\n');
      const agentFd = fs.openSync(t.file, 'a');
      t.person((x) => x.insert(0, 'person\n'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      await t.bridge.close();
      expect(t.staged()).toHaveLength(1);
      const again = t.open();
      await again.bridge.load();
      expect(again.conflicts.map((c) => c.conflict)).toEqual(['interrupted']);
      expect(t.staged()).toHaveLength(1); // Still open for writing: kept, and pending.
      fs.writeSync(agentFd, 'appended\n');
      fs.closeSync(agentFd);
      await expect.poll(() => again.conflicts.find((c) => c.conflict === 'raced'), { timeout: 5000 }).toBeTruthy();
      expect(fs.readFileSync(again.conflicts.find((c) => c.conflict === 'raced').recovery, 'utf8')).toBe('log\nappended\n');
      expect(t.leftovers()).toEqual([]);
      expect(again.text.toString()).toBe('person\nlog\n');
    });

    it('the directory moved outside the project before the open: nothing is published anywhere', async () => {
      const t = await setup('inside\n');
      const outside = path.join(t.home, 'moved-out');
      t.person((x) => x.insert(0, 'x'));
      const result = await t.saveDuring('beforeOpen', () => fs.renameSync(path.join(t.root, 'src'), outside)).catch((error) => ({ error: error.message }));
      expect(result.published).toBeUndefined();
      expect(result.ok).not.toBe(true);
      expect(fs.readdirSync(outside)).toEqual(['notes.md']);
      expect(fs.readFileSync(path.join(outside, 'notes.md'), 'utf8')).toBe('inside\n');
    });

    it('the directory moved outside just before the exchange: reported uncertain, never undone, never merged (residual)', async () => {
      const t = await setup('inside\n');
      const outside = path.join(t.home, 'moved-out');
      t.person((x) => x.insert(0, 'x'));
      const result = await t.saveDuring('beforeExchange', () => fs.renameSync(path.join(t.root, 'src'), outside));
      expect(result).toMatchObject({ ok: false, conflict: 'unverified', published: 'uncertain' });
      expect(fs.readdirSync(outside)).toEqual(['notes.md']);
      expect(t.kept()).toContain('inside\n');
      await t.bridge.sync();
      expect(t.text.toString()).toBe('xinside\n');
      expect(t.bridge.state().conflict.conflict).toBe('unverified');
    });

    it('an outside writer replacing the file right after a save is an ordinary outside write: no replay', async () => {
      const t = await setup('a\n');
      t.person((x) => x.insert(0, 'P'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      const next = path.join(path.dirname(t.file), '.agent-tmp');
      fs.writeFileSync(next, `${t.disk()}X\n`);
      fs.renameSync(next, t.file);
      await t.bridge.sync();
      expect(t.text.toString()).toBe('Pa\nX\n'); // Not 'PPa\nX\n'.
    });

    it('a save a crash interrupted is finished on the next load: its private entry is kept for recovery and removed, with a notice', async () => {
      const t = await setup('before crash\n');
      const left = path.join(t.privateDir, `${keyOf(t.root, 'src/notes.md')}.4242.staged`);
      fs.writeFileSync(left, 'displaced revision\n');
      await t.bridge.close();
      const again = t.open();
      await again.bridge.load();
      await again.bridge.close();
      expect(fs.existsSync(left)).toBe(false);
      expect(again.conflicts.map((c) => c.conflict)).toEqual(['interrupted']);
      expect(fs.readFileSync(again.conflicts[0].recovery, 'utf8')).toBe('displaced revision\n');
      expect(t.disk()).toBe('before crash\n');
    });

    it('project files that look like old staging names (.notes.md.coedit-foo) survive a load untouched', async () => {
      const t = await setup('mine\n');
      const dir = path.dirname(t.file);
      fs.writeFileSync(path.join(dir, '.notes.md.coedit-foo'), 'not ours\n');
      fs.writeFileSync(path.join(dir, 'x.coedit-look-alike'), 'not ours either\n');
      await t.bridge.close();
      const again = t.open();
      await again.bridge.load();
      expect(again.conflicts).toEqual([]);
      expect(fs.readFileSync(path.join(dir, '.notes.md.coedit-foo'), 'utf8')).toBe('not ours\n');
      expect(fs.readFileSync(path.join(dir, 'x.coedit-look-alike'), 'utf8')).toBe('not ours either\n');
    });

    for (const point of ['beforeExchange', 'afterExchange']) {
      it(`the helper killed at ${point}: the save is uncertain; the next load finds the target wholly old or new, leftovers in recovery, nothing in the project`, async () => {
        const t = await setup('old\n');
        t.person((x) => x.insert(0, 'new '));
        t.hooks.helper = { pause: point, pauseMs: 5000 };
        const saving = t.bridge.save();
        if (point === 'beforeExchange') await expect.poll(() => t.staged().length, { timeout: 3000 }).toBe(1);
        else await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('new old\n');
        killHelper(t.root);
        const result = await saving;
        delete t.hooks.helper;
        expect(result).toMatchObject({ ok: false, conflict: 'unverified', published: 'uncertain' });
        expect(t.text.toString()).toBe('new old\n');
        await t.bridge.close();
        const again = t.open();
        await again.bridge.load();
        const [before, after] = point === 'beforeExchange' ? ['old\n', 'new old\n'] : ['new old\n', 'old\n'];
        expect(t.disk()).toBe(before);
        expect(again.text.toString()).toBe(before);
        expect(t.kept()).toContain(after); // What the private dir held is in recovery.
        expect(t.leftovers()).toEqual([]);
        expect(again.conflicts.map((c) => c.conflict)).toEqual(['interrupted']);
      });
    }

    it('fails closed without the helper', () => {
      const saved = process.env.OPENCHAMBER_COEDIT_FS;
      process.env.OPENCHAMBER_COEDIT_FS = '/nonexistent/coedit-fs';
      try {
        expect(() => createDiskBridge({ root: '/a/p', file: '/a/p/f', doc: new Y.Doc(), recoveryDir: '/r', enabled: true })).toThrow(/helper/);
      } finally {
        if (saved === undefined) delete process.env.OPENCHAMBER_COEDIT_FS;
        else process.env.OPENCHAMBER_COEDIT_FS = saved;
      }
    });

    it('without the service socket, the helper is not run as the account it serves unless explicitly allowed (smartyfs#32)', () => {
      const saved = process.env.OPENCHAMBER_COEDIT_SAME_ACCOUNT;
      delete process.env.OPENCHAMBER_COEDIT_SAME_ACCOUNT;
      try {
        expect(() => createDiskBridge({ root: '/a/p', file: '/a/p/f', doc: new Y.Doc(), recoveryDir: '/r', enabled: true })).toThrow(/coedit-fs service/);
      } finally {
        process.env.OPENCHAMBER_COEDIT_SAME_ACCOUNT = saved;
      }
    });

    it('is off unless enabled', () => {
      const saved = process.env.OPENCHAMBER_COEDIT;
      delete process.env.OPENCHAMBER_COEDIT;
      try {
        expect(() => createDiskBridge({ root: '/a/p', file: '/a/p/f', doc: new Y.Doc(), recoveryDir: '/r' })).toThrow(/off/);
      } finally {
        if (saved !== undefined) process.env.OPENCHAMBER_COEDIT = saved;
      }
    });
  });

  describe('uncertain publication (review: replay after a failed check, lost replies, durability)', () => {
    it('base a, room Pa, a fault after the exchange: unverified; sync adopts it by the disk hash, the room is Pa not PPa, a second save writes nothing', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { fault: 'afterExchange' };
      const result = await t.bridge.save();
      delete t.hooks.helper;
      expect(result).toMatchObject({ ok: false, conflict: 'unverified', published: 'uncertain' });
      expect(t.conflicts.at(-1)).toMatchObject({ conflict: 'unverified', published: 'uncertain' });
      expect(t.disk()).toBe('Pa');
      await t.bridge.sync();
      expect(t.text.toString()).toBe('Pa');
      expect(t.bridge.state().conflict).toBe(null);
      const { ino } = fs.statSync(t.file);
      const keptBefore = t.kept().length;
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(fs.statSync(t.file).ino).toBe(ino);
      expect(t.kept()).toHaveLength(keptBefore);
      expect(t.text.toString()).toBe('Pa');
      expect(t.leftovers()).toEqual([]);
    });

    for (const [point, where] of [['beforeExchange', 'the staged inode after its readback'], ['afterExchange', 'the published inode right after the exchange']]) {
      it(`smartyfs#33 (A): an equal-length change to ${where} is never reported as saved; no replay`, async () => {
        const t = await setup('a');
        t.person((x) => x.insert(0, 'P'));
        const result = await t.saveDuring(point, async () => {
          // After the exchange only once ours is in place: a loaded host may not have reached the pause yet.
          if (point === 'afterExchange') await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
          // The same inode, the same length, other bytes: an inode and size check alone would pass it.
          const target = point === 'beforeExchange' ? path.join(t.privateDir, t.staged()[0]) : t.file;
          const fd = fs.openSync(target, 'r+');
          fs.writeSync(fd, 'X', 0);
          fs.closeSync(fd);
        });
        // Ours was published (its inode), then changed: raced, never saved. The base follows ours, so no replay.
        expect(result).toMatchObject({ ok: false, conflict: 'raced', published: true });
        expect(t.disk()).toBe('Xa');
        // At once, before any sync: the room is unchanged, but the disk is not its text. Not saved, nothing written.
        // The raced save's recovery copy and notice are carried, not replaced (#445 security round 3).
        const warning = { recovery: result.recovery, notice: result.notice };
        expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'changed', ...warning });
        expect(t.conflicts.at(-1)).toMatchObject({ conflict: 'changed', ...warning }); // Shown to the room (smartyfs#33 P3).
        expect(t.bridge.state().conflict).toMatchObject({ conflict: 'changed', ...warning });
        expect(t.disk()).toBe('Xa');
        await t.bridge.sync(); // P -> X removes text: held for the person, the room keeps Pa.
        expect(t.text.toString()).toBe('Pa');
        expect(t.bridge.state().conflict).toMatchObject({ conflict: 'removed' });
        expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'removed' }); // Not reported as saved.
        expect(t.disk()).toBe('Xa'); // The other writer's bytes are not overwritten.
        await t.bridge.acceptDisk();
        expect(t.text.toString()).toBe('Xa'); // Accepted: the room takes the disk, P once, never PPa.
        expect(await t.bridge.save()).toEqual({ ok: true });
        expect(t.disk()).toBe('Xa');
      });
    }

    it('#445 security round 1: an unchanged room whose file was deleted is never reported as saved, and nothing is recreated', async () => {
      const t = await setup('a');
      fs.unlinkSync(t.file);
      await t.bridge.sync();
      expect(t.bridge.state().gone).toBe(true);
      const before = t.conflicts.length;
      expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'gone' });
      expect(t.conflicts.slice(before)).toMatchObject([{ conflict: 'gone' }]); // Shown to the room (smartyfs#33 P3).
      expect(t.bridge.state().conflict).toMatchObject({ conflict: 'gone' });
      expect(fs.existsSync(t.file)).toBe(false);
      fs.writeFileSync(t.file, 'a'); // Back as it was: an unchanged room is saved again.
      await t.bridge.sync();
      expect(await t.bridge.save()).toEqual({ ok: true });
    });

    it('smartyfs#33 P3: an unchanged room saved before any sync reports a changed or deleted file to the room', async () => {
      const t = await setup('a');
      fs.writeFileSync(t.file, 'b'); // Changed, no sync.
      expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'changed' });
      expect(t.conflicts.at(-1)).toMatchObject({ conflict: 'changed' });
      expect(t.bridge.state().conflict).toMatchObject({ conflict: 'changed' });
      expect(t.disk()).toBe('b'); // Nothing written over it.
      fs.unlinkSync(t.file); // Deleted, no sync.
      expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'gone' });
      expect(t.conflicts.at(-1)).toMatchObject({ conflict: 'gone' });
      expect(t.bridge.state()).toMatchObject({ gone: true, conflict: { conflict: 'gone' } });
      expect(fs.existsSync(t.file)).toBe(false); // Not recreated.
      expect(t.text.toString()).toBe('a'); // The room is unchanged.
    });

    it('#445 security round 3: a raced save\'s recovery warning outlives no-change refusals and the success after them', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      const raced = await t.saveDuring('afterExchange', async () => {
        await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
        fs.writeFileSync(t.file, 'Qa'); // Another writer, right after ours.
      });
      expect(raced).toMatchObject({ conflict: 'raced', published: true });
      const warning = { recovery: raced.recovery, notice: raced.notice };
      expect(warning.recovery).toBeTruthy();
      // No sync anywhere below: changed, then gone, then the base again.
      expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'changed', ...warning });
      expect(t.bridge.state().conflict).toMatchObject({ conflict: 'changed', ...warning });
      fs.unlinkSync(t.file);
      expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'gone', ...warning });
      expect(t.bridge.state()).toMatchObject({ gone: true, conflict: { conflict: 'gone', ...warning } });
      fs.writeFileSync(t.file, 'Pa'); // The base again.
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.bridge.state()).toMatchObject({ gone: false, conflict: { conflict: 'raced', ...warning } }); // Kept.
      expect(t.disk()).toBe('Pa');
    });

    it('#445 security round 2: a file restored after a refused save is saved again with no sync, and no longer marked gone', async () => {
      const t = await setup('a');
      fs.unlinkSync(t.file);
      expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'gone' });
      fs.writeFileSync(t.file, 'b'); // Restored with other bytes: still refused, but no longer absent.
      const { ino } = fs.statSync(t.file);
      expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'changed' });
      expect(t.bridge.state()).toMatchObject({ gone: false, conflict: { conflict: 'changed' } });
      expect(t.disk()).toBe('b');
      fs.writeFileSync(t.file, 'a'); // Restored exactly (the same inode, rewritten in place).
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.bridge.state()).toMatchObject({ gone: false, conflict: null });
      expect(fs.statSync(t.file).ino).toBe(ino); // Not rewritten by the save.
      expect(t.disk()).toBe('a');
    });

    it('a failed directory sync holds through sync and save while flushes keep failing; a later flush confirms it with no replay (review round 2: durability)', async () => {
      const t = await setup('a', { retryMs: 60_000 });
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { fault: 'dirSync' };
      expect(await t.bridge.save()).toMatchObject({ ok: false, conflict: 'unverified', published: true });
      expect(t.disk()).toBe('Pa');
      const { ino } = fs.statSync(t.file);
      expect(t.staged()).toHaveLength(1); // The displaced revision stays until the save is durable.
      await t.bridge.sync(); // The cache shows Pa: that is no durability receipt.
      expect(t.bridge.state().conflict).toMatchObject({ conflict: 'unverified' });
      expect(await t.bridge.save()).toMatchObject({ ok: false, conflict: 'unverified' });
      expect(t.staged()).toHaveLength(1);
      expect(fs.statSync(t.file).ino).toBe(ino); // Nothing published again.
      const keptBefore = t.kept().length;
      delete t.hooks.helper; // The disk recovers.
      await t.bridge.sync();
      expect(t.bridge.state().conflict).toBe(null);
      expect(t.staged()).toEqual([]);
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(fs.statSync(t.file).ino).toBe(ino);
      expect(t.kept()).toHaveLength(keptBefore);
      expect(t.text.toString()).toBe('Pa');
    });

    it('a failed flush survives close and reopen: load flushes first; while it fails, save holds and the private entry stays; a working flush confirms it with no replay (review round 3)', async () => {
      const t = await setup('a', { retryMs: 60_000 });
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { fault: 'dirSync' }; // Kept failing across the reopen.
      expect(await t.bridge.save()).toMatchObject({ ok: false, conflict: 'unverified', published: true });
      const { ino } = fs.statSync(t.file);
      await t.bridge.close();
      const again = t.open();
      await again.bridge.load();
      expect(again.bridge.state().conflict).toMatchObject({ conflict: 'unverified' });
      expect(t.staged()).toHaveLength(1);
      expect(await again.bridge.save()).toMatchObject({ ok: false, conflict: 'unverified' });
      expect(t.staged()).toHaveLength(1);
      delete t.hooks.helper; // The disk recovers.
      expect(await again.bridge.save()).toEqual({ ok: true });
      expect(again.bridge.state().conflict).toBe(null);
      expect(t.staged()).toEqual([]);
      expect(fs.statSync(t.file).ino).toBe(ino); // Not published again.
      expect(again.text.toString()).toBe('Pa');
      expect(t.kept()).toContain('a'); // The displaced revision is in recovery.
    });

    it('a failed flush of the displaced revision\'s removal is not a durable save until a flush succeeds (review round 2: dispose synced)', async () => {
      const t = await setup('a', { retryMs: 60_000 });
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { fault: 'privSync' };
      expect(await t.bridge.save()).toMatchObject({ ok: false, conflict: 'unverified', published: true });
      expect(await t.bridge.save()).toMatchObject({ ok: false, conflict: 'unverified' });
      delete t.hooks.helper;
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.bridge.state().conflict).toBe(null);
      expect(t.disk()).toBe('Pa');
    });

    it('an uncertain save and a third revision on disk: held, never merged, raised once per revision; save publishes nothing', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { fault: 'afterExchange' };
      await t.bridge.save();
      delete t.hooks.helper;
      fs.writeFileSync(t.file, 'Pa and more');
      await t.bridge.sync();
      await t.bridge.sync();
      expect(t.text.toString()).toBe('Pa');
      expect(t.conflicts.map((c) => c.conflict)).toEqual(['unverified', 'unverified']);
      t.person((x) => x.insert(0, 'Q'));
      expect(await t.bridge.save()).toMatchObject({ ok: false, conflict: 'unverified' });
      expect(t.disk()).toBe('Pa and more');
      fs.writeFileSync(t.file, 'a'); // Back to the base: it was never ours, so it clears.
      await t.bridge.sync();
      expect(t.bridge.state().conflict).toBe(null);
      expect(t.text.toString()).toBe('QPa');
    });

    it('a lost reply (the helper killed after the exchange): uncertain; a new helper settles it by the disk and a flush, with no replay (smartyfs#34 item 1)', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { pause: 'afterExchange', pauseMs: 5000 };
      const saving = t.bridge.save();
      await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
      const [killed] = helperPids(t.root);
      killHelper(t.root);
      const result = await saving;
      delete t.hooks.helper;
      expect(result).toMatchObject({ ok: false, conflict: 'unverified', published: 'uncertain' });
      await t.bridge.sync();
      expect(helperPids(t.root).filter((pid) => pid !== killed && alive(pid))).toHaveLength(1);
      expect(t.text.toString()).toBe('Pa'); // Adopted, not PPa.
      expect(t.bridge.state().conflict).toBe(null);
      const { ino } = fs.statSync(t.file);
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(fs.statSync(t.file).ino).toBe(ino);
    });

    for (const point of ['beforeExchange', 'afterExchange']) {
      it(`a reply lost at ${point}, then an agent's revision: settled by the private dir, never held and never replayed (stress run)`, async () => {
        const t = await setup('a');
        t.person((x) => x.insert(0, 'P'));
        t.hooks.helper = { pause: point, pauseMs: 5000 };
        const saving = t.bridge.save();
        if (point === 'beforeExchange') await expect.poll(() => t.staged().length, { timeout: 3000 }).toBe(1);
        else await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
        killHelper(t.root);
        expect(await saving).toMatchObject({ conflict: 'unverified', published: 'uncertain' });
        delete t.hooks.helper;
        const before = t.disk();
        fs.writeFileSync(t.file, `${before}\nagent`); // An agent's revision, built on whatever it found.
        await t.bridge.sync();
        expect(t.bridge.state().conflict).toBe(null);
        // Published: the base is ours, so the agent's line merges in once (Pa, not PPa). Not: P is still the room's.
        expect(t.text.toString()).toBe('Pa\nagent');
        expect(await t.bridge.save()).toEqual({ ok: true });
        expect(t.disk()).toBe('Pa\nagent');
        expect(t.staged()).toEqual([]);
        if (point === 'afterExchange') expect(t.kept()).toContain('a');
      });
    }

    it('an agent replacing the file right after our exchange: ours was published (the base follows it), theirs is the next revision, never held (stress run)', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      const result = await t.saveDuring('afterExchange', async () => {
        await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
        fs.writeFileSync(`${t.file}.agent`, 'Pa\nagent');
        fs.renameSync(`${t.file}.agent`, t.file); // Built on ours.
      });
      expect(result).toMatchObject({ ok: false, conflict: 'raced', published: true });
      await t.bridge.sync();
      expect(t.text.toString()).toBe('Pa\nagent'); // Merged once from ours: no replay, and not held.
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('Pa\nagent');
    });

    it('a writer that read before our save and replaces the file after it: our revision is kept in recovery, not only in the room (stress run, seed 32)', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      const result = await t.saveDuring('afterExchange', async () => {
        await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
        fs.writeFileSync(`${t.file}.agent`, 'a\nagent'); // Built on what it read before our save.
        fs.renameSync(`${t.file}.agent`, t.file);
      });
      expect(result).toMatchObject({ published: true });
      expect(t.disk()).toBe('a\nagent');
      expect(t.kept()).toContain('Pa'); // Ours survives a crash of the room.
      expect(fs.readdirSync(t.recoveryDir).some((n) => n.includes('-ours-'))).toBe(true);
      expect(t.kept()).toContain('a');
    });

    it('a lost reply is matched to its own staged entry: another save\'s leftover entry does not make it published (round 2 note)', async () => {
      const t = await setup('a');
      // A leftover of an earlier save, not pending: a displaced-looking entry for this key.
      fs.writeFileSync(path.join(t.privateDir, `${keyOf(t.root, 'src/notes.md')}.0badc0de-1.staged`), 'something else');
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { pause: 'beforeExchange', pauseMs: 5000 };
      const saving = t.bridge.save();
      await expect.poll(() => t.staged().length, { timeout: 3000 }).toBe(2);
      killHelper(t.root);
      expect(await saving).toMatchObject({ published: 'uncertain' });
      delete t.hooks.helper;
      await t.bridge.sync();
      expect(t.disk()).toBe('a'); // Never exchanged.
      expect(await t.bridge.save()).toEqual({ ok: true }); // So the room's P is saved now, not taken as published.
      expect(t.disk()).toBe('Pa');
    });

    it('close during a helper restart starts no helper after it (round 2 note)', async () => {
      const t = await setup('a');
      killHelper(t.root);
      await expect.poll(() => helperPids(t.root).filter(alive).length, { timeout: 3000 }).toBe(0);
      const syncing = t.bridge.sync().catch(() => {});
      await t.bridge.close();
      await syncing;
      await sleep(300);
      expect(helperPids(t.root).filter(alive)).toEqual([]);
    });

    it('a failing recovery write never turns a published save into a thrown error that replays the edit (review round 3)', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      const open = fs.promises.open;
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation((p, ...rest) => (String(p).includes('-ours-')
        ? Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
        : open(p, ...rest)));
      const saving = await t.bridge.save().then((r) => r, (error) => ({ threw: String(error.message) }));
      spy.mockRestore();
      // Either nothing was published (the disk is the base), or it was and the base follows ours: never both a throw
      // and a changed disk.
      if (saving.threw) expect(t.disk()).toBe('a');
      await t.bridge.sync();
      expect(t.text.toString()).toBe('Pa'); // Not PPa.
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('Pa');
    });

    it('#412 round 3: a second bridge recovers the orphan of a lost reply; the first still settles it as published, no replay', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { pause: 'afterExchange', pauseMs: 5000 };
      const saving = t.bridge.save();
      await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
      killHelper(t.root);
      expect(await saving).toMatchObject({ published: 'uncertain' });
      delete t.hooks.helper;
      const second = t.open(); // Another bridge on the same file: its load recovers the orphan and disposes it.
      await second.bridge.load();
      expect(t.staged()).toEqual([]);
      await t.bridge.sync(); // The first bridge settles its lost reply.
      expect(t.bridge.state().conflict).toBe(null);
      expect(t.text.toString()).toBe('Pa'); // Adopted, not replayed as PPa.
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('Pa');
    });

    it('smartyfs#32 pre-enable: after a server restart, the next load recovers a pending revision at once, late bytes included', async () => {
      const t = await setup('log\n');
      const writer = fs.openSync(t.file, 'a'); // An agent that keeps the old inode open across the restart.
      // The "server" before the restart: a bridge in another process saves, then that process ends abruptly.
      const script = path.join(t.home, 'server.mjs');
      fs.writeFileSync(script, `
        process.env.OPENCHAMBER_COEDIT_SAME_ACCOUNT = '1';
        const Y = await import(${JSON.stringify(import.meta.resolve('yjs'))});
        const { createDiskBridge, TEXT } = await import(${JSON.stringify(path.join(import.meta.dirname, 'disk-bridge.js'))});
        const doc = new Y.Doc();
        const bridge = createDiskBridge({ root: ${JSON.stringify(t.root)}, file: ${JSON.stringify(t.file)}, doc, recoveryDir: ${JSON.stringify(t.recoveryDir)}, watch: () => ({ close() {} }), settleMs: 20, retryMs: 60000, enabled: true });
        await bridge.load();
        doc.getText(TEXT).insert(0, 'P');
        console.log(JSON.stringify(await bridge.save()));
        process.kill(process.pid, 'SIGKILL');
      `);
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 30_000 });
      expect(run.signal).toBe('SIGKILL'); // It died, as a crashed or restarted server does.
      expect(JSON.parse(run.stdout.trim())).toEqual({ ok: true }); // Published; its displaced revision stayed pending (the writer).
      expect(t.staged()).toHaveLength(1);
      await sleep(300);
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      // The restarted server's bridge: it holds no token, and must not wait 7 days.
      const again = t.open();
      await again.bridge.load();
      expect(again.conflicts.map((c) => c.conflict)).toContain('raced'); // The helper's recovery, with its notice.
      expect(again.text.toString()).toBe('Plog\n');
      expect(t.kept().filter((k) => k === 'log\nlate\n')).toHaveLength(1);
      expect(t.staged()).toEqual([]);
      // Loading again does not keep it twice.
      await again.bridge.close();
      const third = t.open();
      await third.bridge.load();
      expect(t.kept().filter((k) => k === 'log\nlate\n')).toHaveLength(1);
    });

    it('#428 round 3: a list that cannot inspect a data entry never settles a lost reply; the token stays and the late bytes are collected', async () => {
      const t = await setup('a');
      const writer = fs.openSync(t.file, 'a'); // Keeps the displaced revision pending.
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { pause: 'afterExchange', pauseMs: 5000 };
      const saving = t.bridge.save();
      await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
      killHelper(t.root); // Only the helper connection is lost; this bridge (the origin) lives, holding its token.
      expect(await saving).toMatchObject({ published: 'uncertain' });
      const before = tokenCount();
      t.hooks.helper = { fault: 'entryStat' }; // The published record reads fine; the data-entry pass fails.
      await t.bridge.sync().catch(() => {});
      expect(t.bridge.state().conflict).toMatchObject({ conflict: 'unverified' }); // Not settled on a partial list.
      expect(tokenCount()).toBe(before);
      delete t.hooks.helper;
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      await t.bridge.sync(); // Reads work again: settled, and its revision enrolled with its token.
      await expect.poll(() => t.conflicts.find((c) => c.conflict === 'raced'), { timeout: 5000 }).toBeTruthy();
      expect(fs.readFileSync(t.conflicts.find((c) => c.conflict === 'raced').recovery, 'utf8')).toBe('alate\n');
      expect(t.text.toString()).toBe('Pa'); // No replay.
      await expect.poll(() => tokenCount(), { timeout: 5000 }).toBe(before - 1);
    });

    it('#428 round 3: an ack that reports pending data keeps the token, and the data is enrolled and collected', async () => {
      const t = await setup('a');
      const writer = fs.openSync(t.file, 'a');
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { pause: 'afterExchange', pauseMs: 5000 };
      const saving = t.bridge.save();
      await expect.poll(() => t.disk(), { timeout: 3000 }).toBe('Pa');
      killHelper(t.root);
      await saving;
      delete t.hooks.helper;
      const before = tokenCount();
      // Hide the entry from this one settlement only: the ack then sees the data and says pending.
      t.hooks.helper = { fault: 'entryHidden' };
      await t.bridge.sync();
      delete t.hooks.helper;
      expect(tokenCount()).toBe(before); // Kept: ack said pending.
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      await expect.poll(() => t.conflicts.find((c) => c.conflict === 'raced'), { timeout: 5000 }).toBeTruthy();
      expect(fs.readFileSync(t.conflicts.find((c) => c.conflict === 'raced').recovery, 'utf8')).toBe('alate\n');
    });

    it('smartyfs#37 item 16: an ack that is done but whose reply is lost does not leave its token registered', async () => {
      const t = await setup('a');
      const before = tokenCount();
      t.person((x) => x.insert(0, 'P'));
      // Lost before its record is linked: no record and no data, so its settlement acks with nothing to dispose.
      t.hooks.helper = { pause: 'beforeRecordLink', pauseMs: 5000 };
      const saving = t.bridge.save();
      await expect.poll(() => tokenCount(), { timeout: 3000 }).toBe(before + 1);
      await new Promise((resolve) => setTimeout(resolve, 300)); // The helper waits before linking the record.
      killHelper(t.root);
      expect(await saving).toMatchObject({ published: 'uncertain' });
      t.hooks.helper = { fault: 'ackLost' }; // The helper removes the receipt; the bridge never hears it.
      await t.bridge.sync();
      delete t.hooks.helper;
      await t.bridge.save(); // Not published: saved again, as its own transaction.
      await expect.poll(() => t.disk(), { timeout: 5000 }).toBe('Pa');
      // Later complete lists show neither the record nor data of the lost-ack transaction: its token goes too.
      await expect.poll(() => tokenCount(), { timeout: 5000 }).toBe(before);
    });

    it('smartyfs#37 item 16: a list never drops the token of a save still being published', async () => {
      const t = await setup('a');
      const before = tokenCount();
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { pause: 'beforeLock', pauseMs: 1500 };
      const saving = t.bridge.save();
      await expect.poll(() => tokenCount(), { timeout: 3000 }).toBe(before + 1);
      // Another connection of this process lists the file before the helper has even taken the file's lock for this
      // publish: no record and no data of it yet.
      const other = startHelper(t.root, t.privateDir);
      try {
        await collectRecovered(other, keyOf(t.root, 'src/notes.md'), 'src/notes.md', t.recoveryDir);
        expect(tokenCount()).toBe(before + 1); // Still settling: its token stays.
      } finally {
        await other.close();
      }
      delete t.hooks.helper;
      expect(await saving).toMatchObject({ ok: true });
      await expect.poll(() => tokenCount(), { timeout: 5000 }).toBe(before); // Published and disposed: now it goes.
    });

    it('#436 round 1: an empty list sent before a publish, answered after it settled, keeps that publish\'s token', async () => {
      const t = await setup('log\n');
      const before = tokenCount();
      const agentFd = fs.openSync(t.file, 'a'); // Keeps the displaced revision: the publish retains data.
      t.person((x) => x.insert(0, 'person\n'));
      t.hooks.helper = { pause: 'beforeLock', pauseMs: 800 };
      const saving = t.bridge.save();
      await expect.poll(() => tokenCount(), { timeout: 3000 }).toBe(before + 1);
      // Another connection of this process lists first (no record, no data yet); its reply comes after the publish's.
      const other = startHelper(t.root, t.privateDir, { testHooks: true });
      try {
        const listing = collectRecovered(other, keyOf(t.root, 'src/notes.md'), 'src/notes.md', t.recoveryDir, { helper: { pause: 'beforeReply', pauseMs: 2500 } });
        expect(await saving).toEqual({ ok: true });
        await listing;
        expect(tokenCount()).toBe(before + 1); // Still held: its data is retained.
      } finally {
        await other.close();
      }
      delete t.hooks.helper;
      await t.bridge.close();
      const again = t.open(); // Reopened in this process: its token reclaims the retained revision.
      await again.bridge.load();
      fs.writeSync(agentFd, 'appended\n');
      fs.closeSync(agentFd);
      await expect.poll(() => again.conflicts.find((c) => c.conflict === 'raced'), { timeout: 5000 }).toBeTruthy();
      expect(fs.readFileSync(again.conflicts.find((c) => c.conflict === 'raced').recovery, 'utf8')).toBe('log\nappended\n');
      expect(t.leftovers()).toEqual([]);
    });

    it('smartyfs#37 item 15: the token registry keeps only tokens still needed', async () => {
      const t = await setup('a\n');
      const before = tokenCount();
      fs.chmodSync(t.root, 0o777); // Every publish is refused by the helper (another account could move src/).
      for (let i = 0; i < 5; i += 1) {
        t.person((x) => x.insert(0, 'x'));
        await t.bridge.save().catch(() => null);
      }
      expect(tokenCount()).toBe(before); // Definite refusals keep nothing.
      fs.chmodSync(t.root, 0o755);
      await t.bridge.sync();
      const writer = fs.openSync(t.file, 'a');
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(tokenCount()).toBe(before + 1); // A pending revision keeps its token.
      fs.closeSync(writer);
      await t.bridge.sync(); // Its revision is collected: the token goes.
      await expect.poll(() => t.staged(), { timeout: 5000 }).toEqual([]);
      expect(tokenCount()).toBe(before);
      // A lost reply settled with no retained data (the exchange never ran) keeps nothing either.
      t.person((x) => x.insert(0, 'Q'));
      t.hooks.helper = { pause: 'beforeExchange', pauseMs: 5000 };
      const saving = t.bridge.save();
      await expect.poll(() => t.staged().length, { timeout: 3000 }).toBe(1);
      killHelper(t.root);
      expect(await saving).toMatchObject({ published: 'uncertain' });
      delete t.hooks.helper;
      await t.bridge.sync();
      expect(t.bridge.state().conflict).toBe(null);
      expect(tokenCount()).toBe(before);
    });

    it('a lost helper is started again: an outside write after the kill reaches the room, and a save publishes (smartyfs#34 item 1)', async () => {
      const t = await setup('hello\n', { watch: true });
      killHelper(t.root);
      await expect.poll(() => helperPids(t.root).filter(alive).length, { timeout: 3000 }).toBe(0);
      fs.writeFileSync(t.file, 'hello\nagent\n');
      await expect.poll(() => t.text.toString(), { timeout: 5000 }).toBe('hello\nagent\n');
      t.person((x) => x.insert(0, 'P'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('Phello\nagent\n');
    });

    it('a FIFO in place of the file never blocks: refused promptly, and close is prompt', async () => {
      const t = await setup('a');
      fs.unlinkSync(t.file);
      execFileSync('mkfifo', [t.file]);
      const started = Date.now();
      await expect(t.bridge.sync()).rejects.toThrow(/regular file/);
      await t.bridge.close();
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });

  describe('smartyfs#34 follow-ups: keys and test hooks', () => {
    it('two projects with the same relative path and one recovery directory never collect each other\'s entries (item 14)', async () => {
      const t = await setup('mine\n');
      const rootB = path.join(t.home, 'project-b');
      fs.mkdirSync(path.join(rootB, 'src'), { recursive: true });
      fs.writeFileSync(path.join(rootB, 'src', 'notes.md'), 'theirs\n');
      const conflictsB = [];
      const b = createDiskBridge({ root: rootB, file: path.join(rootB, 'src', 'notes.md'), doc: new Y.Doc(), recoveryDir: t.recoveryDir, hooks: {}, watch: () => ({ close() {} }), settleMs: 20, onConflict: (c) => conflictsB.push(c), enabled: true });
      cleanups.unshift(() => void b.close());
      t.person((x) => x.insert(0, 'P'));
      const result = await t.saveDuring('beforeExchange', () => b.load()); // B loads while A's entry is staged.
      expect(result).toEqual({ ok: true });
      expect(t.disk()).toBe('Pmine\n');
      expect(conflictsB).toEqual([]);
      expect(keyOf(t.root, 'src/notes.md')).not.toBe(keyOf(rootB, 'src/notes.md'));
    });

    it('a helper not started for tests ignores test hooks, even with COEDIT_FS_TEST set (item 12)', async () => {
      const t = await setup('a');
      expect(process.env.COEDIT_FS_TEST).toBe('1');
      const helper = startHelper(t.root, t.privateDir);
      try {
        const current = await readFile(helper, 'src/notes.md');
        const result = await publish(helper, 'src/notes.md', 'b', current.hash, { recoveryDir: t.recoveryDir, key: keyOf(t.root, 'src/notes.md'), hooks: { helper: { fault: 'dirSync' } } });
        expect(result).toMatchObject({ ok: true });
      } finally {
        await helper.close();
      }
    });

    it('a test hook cannot replace the request\'s fields (item 15)', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      t.hooks.helper = { op: 'read', path: 'elsewhere', fault: 'none' };
      expect(await t.bridge.save()).toEqual({ ok: true });
      delete t.hooks.helper;
      expect(t.disk()).toBe('Pa');
    });
  });

  describe('smartyfs#37 items 3 and 5', () => {
    it('a file with a 220-byte name saves: recovery names stay within NAME_MAX (item 3)', async () => {
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
      cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
      const root = path.join(home, 'p');
      fs.mkdirSync(root);
      const file = path.join(root, `${'n'.repeat(217)}.md`);
      fs.writeFileSync(file, 'a');
      const doc = new Y.Doc();
      const bridge = createDiskBridge({ root, file, doc, recoveryDir: path.join(home, 'r'), watch: () => ({ close() {} }), settleMs: 5, enabled: true });
      cleanups.unshift(() => void bridge.close());
      await bridge.load();
      doc.getText(TEXT).insert(0, 'P');
      expect(await bridge.save()).toEqual({ ok: true });
      expect(fs.readFileSync(file, 'utf8')).toBe('Pa');
      const kept = fs.readdirSync(path.join(home, 'r')).filter((n) => n !== '.staging');
      expect(kept).toHaveLength(2);
      for (const n of kept) expect(Buffer.byteLength(n)).toBeLessThanOrEqual(255);
    });

    it('a helper that does not speak this protocol is refused before any request (item 5)', async () => {
      const { root, privateDir } = fakeHelper(`require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const r = JSON.parse(l); process.stdout.write(JSON.stringify({ id: r.id, ok: false, error: 'unknown op' }) + '\\n'); });`);
      const helper = startHelper(root, privateDir);
      await expect(helper.call({ op: 'read', path: 'x' })).rejects.toThrow(/protocol/);
      await helper.close();
      expect(alive(helper.pid)).toBe(false);
    });
  });

  describe('recovery retention (smartyfs#37: 7 days, and always the newest 20 per file)', () => {
    const DAY = 86_400_000;
    /** A recovery copy of `key`'s file, written `ageDays` ago, named as keepForRecovery names it. */
    const copy = (dir, key, ageDays, i, name = 'notes.md') => {
      const stamp = new Date(Date.now() - ageDays * DAY - i * 1000).toISOString().replace(/[:.]/g, '-');
      const p = path.join(dir, `${stamp}-${(0x10000000 + i).toString(16)}-${key}-${name}`);
      fs.writeFileSync(p, `copy ${ageDays} ${i}`);
      return path.basename(p);
    };
    const prepare = () => {
      const t = { home: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-'))) };
      cleanups.push(() => fs.rmSync(t.home, { recursive: true, force: true }));
      t.root = path.join(t.home, 'project');
      fs.mkdirSync(path.join(t.root, 'src'), { recursive: true });
      t.file = path.join(t.root, 'src', 'notes.md');
      fs.writeFileSync(t.file, 'x');
      t.recoveryDir = path.join(t.home, 'recovery');
      fs.mkdirSync(t.recoveryDir, { mode: 0o700 });
      t.key = keyOf(t.root, 'src/notes.md');
      return t;
    };
    const open = (t, extra = {}) => {
      const bridge = createDiskBridge({ root: t.root, file: t.file, doc: new Y.Doc(), recoveryDir: t.recoveryDir, hooks: {}, watch: () => ({ close() {} }), settleMs: 5, enabled: true, ...extra });
      cleanups.unshift(() => void bridge.close());
      return bridge;
    };

    it('at load: a copy older than 7 days beyond its file\'s newest 20 is deleted; the newest 20 stay, however old', async () => {
      const t = prepare();
      const old = Array.from({ length: 25 }, (_, i) => copy(t.recoveryDir, t.key, 10, i)); // All 10 days old.
      await open(t).load();
      const left = fs.readdirSync(t.recoveryDir).filter((n) => n.includes(t.key));
      expect(left.sort()).toEqual(old.slice(0, 20).sort()); // i = 0..19 are the newest.
    });

    it('at load: a copy younger than 7 days stays even beyond the newest 20; other files\' copies and other names are untouched', async () => {
      const t = prepare();
      const recent = Array.from({ length: 22 }, (_, i) => copy(t.recoveryDir, t.key, 1, i));
      const old = Array.from({ length: 3 }, (_, i) => copy(t.recoveryDir, t.key, 30, i));
      const other = Array.from({ length: 25 }, (_, i) => copy(t.recoveryDir, 'f'.repeat(16), 30, i));
      fs.writeFileSync(path.join(t.recoveryDir, 'my-notes.txt'), 'not a copy');
      fs.symlinkSync(t.file, path.join(t.recoveryDir, `2000-01-01T00-00-00-000Z-deadbeef-${t.key}-link.md`));
      await open(t).load();
      const left = new Set(fs.readdirSync(t.recoveryDir));
      for (const n of recent) expect(left.has(n)).toBe(true);
      for (const n of old) expect(left.has(n)).toBe(false);
      for (const n of other) expect(left.has(n)).toBe(true);
      expect(left.has('my-notes.txt')).toBe(true);
      expect(left.has(`2000-01-01T00-00-00-000Z-deadbeef-${t.key}-link.md`)).toBe(true);
    });

    it('daily: copies that age past the limits while the bridge runs are removed on its own', async () => {
      const t = prepare();
      const bridge = open(t, { pruneMs: 100 });
      await bridge.load();
      const old = Array.from({ length: 25 }, (_, i) => copy(t.recoveryDir, t.key, 10, i));
      await expect.poll(() => fs.readdirSync(t.recoveryDir).filter((n) => n.includes(t.key)).length, { timeout: 3000 }).toBe(20);
      expect(fs.existsSync(path.join(t.recoveryDir, old[24]))).toBe(false);
    });

    it('a save\'s recovery copies carry the file\'s key in their names', async () => {
      const t = await setup('a');
      t.person((x) => x.insert(0, 'P'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      const key = keyOf(t.root, 'src/notes.md');
      const names = fs.readdirSync(t.recoveryDir).filter((n) => n !== '.staging');
      expect(names).toHaveLength(2);
      for (const n of names) expect(n).toContain(`-${key}-`);
    });
  });

  describe('the coedit-fs service (smartyfs#32: the helper as its own account, one per connection)', () => {
    /** A stand-in for systemd's Accept=yes socket unit: each connection gets its own real helper on that socket. */
    const service = async (args) => {
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-svc-')));
      const staging = path.join(home, 'staging');
      fs.mkdirSync(staging, { mode: 0o700 });
      const sock = path.join(home, 'fs.sock');
      const helpers = [];
      const server = net.createServer((conn) => {
        helpers.push(spawn(path.join(import.meta.dirname, 'fs-helper/target/release/coedit-fs'), ['--socket', staging, ...args], { stdio: [conn, conn, 'ignore'] }));
        conn.destroy(); // As systemd does: only the helper holds the connection, so its exit closes it.
      });
      await new Promise((done) => server.listen(sock, done));
      const saved = process.env.OPENCHAMBER_COEDIT_SOCKET;
      process.env.OPENCHAMBER_COEDIT_SOCKET = sock;
      cleanups.push(() => {
        if (saved === undefined) delete process.env.OPENCHAMBER_COEDIT_SOCKET;
        else process.env.OPENCHAMBER_COEDIT_SOCKET = saved;
        for (const h of helpers) h.kill('SIGKILL');
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
      });
      return { staging, helpers };
    };

    it('the bridge saves through the service: the root goes in the hello, staging lives in the service\'s own dir', async () => {
      // --same-account only because a test cannot run as a second account; the real unit never passes it.
      const { staging } = await service(['--same-account']);
      const t = await setup('a\n');
      t.person((x) => x.insert(0, 'P'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('Pa\n');
      expect(fs.existsSync(t.privateDir)).toBe(false); // The bridge made no staging dir of its own.
      expect(fs.readdirSync(staging).filter((n) => !n.endsWith('-lock'))).toEqual([]); // Only its per-file lock remains.
    });

    it('#412 round 2, finding 2: close says whether the service helper is quiescent: bye answered, or not within the bound', async () => {
      const { staging } = await service(['--same-account']);
      const t = await setup('a\n');
      expect(await t.bridge.close()).toEqual({ quiescent: true });
      // A helper busy past the bound: close does not claim it stopped.
      const again = t.open({ closeMs: 50 });
      await again.bridge.load();
      again.text.insert(0, 'P');
      t.hooks.helper = { pause: 'beforeExchange', pauseMs: 2500 };
      const saving = again.bridge.save().catch(() => null);
      // Wait until the helper is provably mid-save (its staged entry exists), however loaded the host.
      await expect.poll(() => fs.readdirSync(staging).some((n) => n.endsWith('.staged')), { timeout: 10_000 }).toBe(true);
      const closing = await Promise.race([again.bridge.close(), sleep(20_000).then(() => 'hung')]);
      delete t.hooks.helper;
      await saving;
      expect(closing).toEqual({ quiescent: false });
    }, 30_000);

    it('a service helper that would serve its own account refuses, and the bridge fails closed', async () => {
      await service([]);
      await expect(setup('a\n')).rejects.toThrow(/coedit-fs/);
    });
  });

  describe('the helper process (review: frames, deadlines, close)', () => {
    it('a truncated reply rejects the call, with no uncaught exception', async () => {
      const { root, privateDir } = fakeHelper(`process.stdin.once('data', () => process.stdout.write('{"id":1,"ok":tr', () => process.exit(0)));`);
      const helper = startHelper(root, privateDir);
      await expect(helper.call({ op: 'read', path: 'x' })).rejects.toThrow(/coedit-fs/);
      await helper.close();
      expect(alive(helper.pid)).toBe(false);
    });

    it('a garbage reply ends the helper: the call rejects and the process is killed', async () => {
      const { root, privateDir } = fakeHelper(`process.stdin.once('data', () => process.stdout.write('garbage\\n')); ${SILENT}`);
      const helper = startHelper(root, privateDir);
      await expect(helper.call({ op: 'read', path: 'x' })).rejects.toThrow(/bad reply/);
      await expect.poll(() => alive(helper.pid), { timeout: 2000 }).toBe(false);
      await helper.close();
    });

    it('a helper that never replies: the call rejects at its deadline, and close resolves with the process exited', async () => {
      const { root, privateDir } = fakeHelper(SILENT);
      const helper = startHelper(root, privateDir, { timeoutMs: 300 });
      const started = Date.now();
      await expect(helper.call({ op: 'read', path: 'x' })).rejects.toThrow(/did not answer/);
      expect(Date.now() - started).toBeLessThan(2000);
      await helper.close();
      expect(alive(helper.pid)).toBe(false);
    });

    it('a bridge whose helper hangs closes within its bound, and the process has exited', async () => {
      const { root } = fakeHelper(SILENT);
      const file = path.join(root, 'f.md');
      fs.writeFileSync(file, 'x');
      const recoveryDir = `${root}-recovery`;
      cleanups.push(() => fs.rmSync(recoveryDir, { recursive: true, force: true }));
      const bridge = createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir, watch: () => ({ close() {} }), enabled: true, timeoutMs: 60_000, closeMs: 200 });
      const loading = bridge.load();
      loading.catch(() => {});
      await sleep(100);
      const [pid] = helperPids(root);
      const started = Date.now();
      await bridge.close();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(alive(pid)).toBe(false);
      await expect(loading).rejects.toThrow();
    });
  });

  it('a directory swapped for a link to outside is refused before anything is written', async () => {
    const t = await setup('inside\n');
    const elsewhere = path.join(t.home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'notes.md'), 'other\n');
    fs.renameSync(path.join(t.root, 'src'), path.join(t.root, 'src-real'));
    fs.symlinkSync(elsewhere, path.join(t.root, 'src'));
    t.person((x) => x.insert(0, 'x'));
    await expect(t.bridge.save()).rejects.toThrow(/left its project/);
    expect(fs.readdirSync(elsewhere)).toEqual(['notes.md']);
    expect(fs.readFileSync(path.join(elsewhere, 'notes.md'), 'utf8')).toBe('other\n');
  });

  it('a file swapped for a link is refused, never followed', async () => {
    const t = await setup('inside\n');
    const outside = path.join(t.home, 'outside.md');
    fs.writeFileSync(outside, 'secret\n');
    fs.unlinkSync(t.file);
    fs.symlinkSync(outside, t.file);
    t.person((x) => x.insert(0, 'x'));
    await expect(t.bridge.save()).rejects.toThrow(/link/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret\n');
  });

  it('merges only settled revisions: a writer still writing is waited out', async () => {
    const { text, file, bridge } = await setup('v1\n');
    const handle = fs.openSync(file, 'a'); // Appended in pieces (a writer still writing).
    const writing = (async () => {
      for (let i = 0; i < 5; i += 1) {
        fs.writeSync(handle, `line ${i}\n`);
        await new Promise((done) => setTimeout(done, 5));
      }
      fs.closeSync(handle);
    })();
    const merged = [];
    text.observe(() => merged.push(text.toString()));
    await bridge.sync();
    await writing;
    await bridge.sync();
    expect(text.toString()).toBe(fs.readFileSync(file, 'utf8'));
    expect(merged.every((shown) => shown === 'v1\nline 0\nline 1\nline 2\nline 3\nline 4\n')).toBe(true);
  });

  describe('bootstrap and lifecycle (security round 2: P2s)', () => {
    const fakeWatch = () => {
      const made = [];
      const watch = (_dir, onChange) => {
        const w = new EventEmitter();
        w.onChange = onChange;
        w.closed = false;
        w.close = () => { w.closed = true; };
        made.push(w);
        return w;
      };
      return { made, watch };
    };
    const fresh = () => {
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
      cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
      const root = path.join(home, 'p');
      fs.mkdirSync(root);
      return { home, root, file: path.join(root, 'f.md') };
    };

    it('a .staging link is refused before any change: the linked directory keeps its mode', async () => {
      const { home, root, file } = fresh();
      fs.writeFileSync(file, 'x');
      const recoveryDir = path.join(home, 'r');
      const elsewhere = path.join(home, 'elsewhere');
      fs.mkdirSync(recoveryDir, { mode: 0o700 });
      fs.mkdirSync(elsewhere);
      fs.chmodSync(elsewhere, 0o755);
      fs.symlinkSync(elsewhere, path.join(recoveryDir, '.staging'));
      expect(() => createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir, watch: () => ({ close() {} }), enabled: true })).toThrow(/link/);
      expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o755);
      expect(helperPids(root)).toEqual([]);
    });

    it('a recovery directory others can write to is refused; an existing .staging of ours is made 0700 through its descriptor', async () => {
      const { home, root, file } = fresh();
      fs.writeFileSync(file, 'x');
      const shared = path.join(home, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      expect(() => createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir: shared, watch: () => ({ close() {} }), enabled: true })).toThrow(/recovery directory/);
      expect(fs.existsSync(path.join(shared, '.staging'))).toBe(false);
      const recoveryDir = path.join(home, 'r');
      fs.mkdirSync(path.join(recoveryDir, '.staging'), { recursive: true });
      fs.chmodSync(recoveryDir, 0o700);
      fs.chmodSync(path.join(recoveryDir, '.staging'), 0o755);
      const bridge = createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir, watch: () => ({ close() {} }), enabled: true });
      await bridge.close();
      expect(fs.statSync(path.join(recoveryDir, '.staging')).mode & 0o777).toBe(0o700);
    });

    it('a new recovery tree is named durably: each created directory is synced in its parent, and a failed sync fails closed', async () => {
      const { home, root, file } = fresh();
      fs.writeFileSync(file, 'x');
      const recoveryDir = path.join(home, 'a', 'b', 'recovery');
      const open = fs.openSync;
      const paths = new Map();
      const synced = [];
      let failAt = null;
      vi.spyOn(fs, 'openSync').mockImplementation((p, ...rest) => {
        const fd = open(p, ...rest);
        paths.set(fd, String(p));
        return fd;
      });
      const fsync = fs.fsyncSync;
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (paths.get(fd) === failAt) throw Object.assign(new Error('EIO: fsync'), { code: 'EIO' });
        synced.push(paths.get(fd));
        return fsync(fd);
      });
      failAt = path.join(home, 'a');
      expect(() => createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir, watch: () => ({ close() {} }), enabled: true })).toThrow(/EIO/);
      expect(fs.existsSync(path.join(home, 'a', 'b'))).toBe(true); // A partial tree is left behind.
      // Retried as it is (review round 3): the failed flush naming b in a is tried again, and still fails closed.
      expect(() => createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir, watch: () => ({ close() {} }), enabled: true })).toThrow(/EIO/);
      expect(helperPids(root)).toEqual([]);
      failAt = null;
      synced.length = 0;
      const bridge = createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir, watch: () => ({ close() {} }), enabled: true });
      await bridge.close();
      for (const parent of [home, path.join(home, 'a'), path.join(home, 'a', 'b'), recoveryDir]) expect(synced).toContain(parent);
    });

    it('a failed load releases its watcher; a retry and close release every watcher; a second load is refused', async () => {
      const { home, root, file } = fresh();
      const { made, watch } = fakeWatch();
      const doc = new Y.Doc();
      const bridge = createDiskBridge({ root, file, doc, recoveryDir: path.join(home, 'r'), watch, settleMs: 5, enabled: true });
      cleanups.unshift(() => void bridge.close());
      await expect(bridge.load()).rejects.toThrow(/does not exist/);
      fs.writeFileSync(file, 'x\n');
      await bridge.load();
      await expect(bridge.load()).rejects.toThrow(/already loaded/);
      expect(doc.getText(TEXT).toString()).toBe('x\n');
      await bridge.close();
      expect(made).toHaveLength(2);
      expect(made.every((w) => w.closed)).toBe(true);
    });

    it('a watcher error during a failing load leaves no restart behind; a retry and close release every watcher (review round 3)', async () => {
      const { home, root, file } = fresh();
      const { made, watch } = fakeWatch();
      // The first watcher fails at once, so its restart (2 s) comes due after the load has failed (the reviewer's order).
      const failing = (dir, onChange) => {
        const w = watch(dir, onChange);
        if (made.length === 1) setImmediate(() => w.emit('error', new Error('EMFILE')));
        return w;
      };
      const bridge = createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir: path.join(home, 'r'), watch: failing, settleMs: 5, retryMs: 2000, enabled: true });
      cleanups.unshift(() => void bridge.close());
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(bridge.load()).rejects.toThrow(/does not exist/);
      const atFailure = made.length;
      await sleep(2500); // Past the restart delay.
      expect(made).toHaveLength(atFailure); // No stale restart.
      expect(made.every((w) => w.closed)).toBe(true);
      fs.writeFileSync(file, 'x\n');
      await bridge.load();
      await sleep(2500);
      await bridge.close();
      expect(made).toHaveLength(atFailure + 1);
      expect(made.every((w) => w.closed)).toBe(true);
    }, 15_000);

    it('a watcher error is shown (unwatched); watching resumes on its own and an outside write made meanwhile reaches the room', async () => {
      const { home, root, file } = fresh();
      fs.writeFileSync(file, 'v1\n');
      const { made, watch } = fakeWatch();
      const doc = new Y.Doc();
      const conflicts = [];
      const bridge = createDiskBridge({ root, file, doc, recoveryDir: path.join(home, 'r'), watch, settleMs: 5, debounceMs: 5, retryMs: 50, onConflict: (c) => conflicts.push(c), enabled: true });
      cleanups.unshift(() => void bridge.close());
      await bridge.load();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      made[0].emit('error', new Error('EMFILE'));
      expect(made[0].closed).toBe(true);
      expect(bridge.state().conflict).toMatchObject({ conflict: 'unwatched' });
      fs.writeFileSync(file, 'v1\nv2\n'); // No event reaches the stopped watcher.
      await expect.poll(() => doc.getText(TEXT).toString(), { timeout: 3000 }).toBe('v1\nv2\n');
      expect(made).toHaveLength(2);
      await expect.poll(() => bridge.state().conflict, { timeout: 3000 }).toBe(null);
      await bridge.close();
      expect(made.every((w) => w.closed)).toBe(true);
    });

    it('#445 astra round 2: a stopped watcher\'s warning outlives no-change refusals and the success after them', async () => {
      const { home, root, file } = fresh();
      fs.writeFileSync(file, 'a');
      const { made, watch } = fakeWatch();
      const bridge = createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir: path.join(home, 'r'), watch, settleMs: 5, retryLimit: 0, enabled: true });
      cleanups.unshift(() => void bridge.close());
      await bridge.load();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      made[0].emit('error', new Error('EMFILE')); // Stopped for good: no restart allowed.
      const unwatched = bridge.state().conflict;
      expect(unwatched).toMatchObject({ conflict: 'unwatched' });
      // No sync anywhere below: changed, then gone, then the base again.
      fs.writeFileSync(file, 'b');
      expect(await bridge.save()).toMatchObject({ ok: false, conflict: 'changed', notice: unwatched.notice });
      expect(bridge.state().conflict).toMatchObject({ conflict: 'changed', kept: { conflict: 'unwatched' } });
      fs.unlinkSync(file);
      expect(await bridge.save()).toMatchObject({ ok: false, conflict: 'gone' });
      expect(bridge.state().conflict).toMatchObject({ conflict: 'gone', kept: { conflict: 'unwatched' } });
      fs.writeFileSync(file, 'a');
      expect(await bridge.save()).toEqual({ ok: true });
      expect(bridge.state().conflict).toMatchObject({ conflict: 'unwatched' }); // Still not watching: still shown.
      expect(made).toHaveLength(1);
    });

    it('#445 astra round 2: watching that resumes clears the watcher warning a refusal carried, and only it', async () => {
      const { home, root, file } = fresh();
      fs.writeFileSync(file, 'a');
      const { made, watch } = fakeWatch();
      const bridge = createDiskBridge({ root, file, doc: new Y.Doc(), recoveryDir: path.join(home, 'r'), watch, settleMs: 5, retryMs: 1500, enabled: true }); // Room to save before the restart.
      cleanups.unshift(() => void bridge.close());
      await bridge.load();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      made[0].emit('error', new Error('EMFILE'));
      fs.unlinkSync(file);
      expect(await bridge.save()).toMatchObject({ ok: false, conflict: 'gone' }); // Before the restart.
      expect(bridge.state().conflict).toMatchObject({ conflict: 'gone', kept: { conflict: 'unwatched' } });
      await expect.poll(() => made.length, { timeout: 3000 }).toBe(2); // Watching again.
      await expect.poll(() => bridge.state().conflict?.kept, { timeout: 3000 }).toBeUndefined();
      expect(bridge.state()).toMatchObject({ gone: true, conflict: { conflict: 'gone' } }); // The file is still gone.
      fs.writeFileSync(file, 'a');
      expect(await bridge.save()).toEqual({ ok: true });
      expect(bridge.state().conflict).toBe(null);
    });

    it('gone clears when a save publishes over a restored file, with no sync between', async () => {
      const t = await setup('x\n');
      fs.unlinkSync(t.file);
      t.person((x) => x.insert(0, 'y'));
      expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'gone' });
      expect(t.bridge.state().gone).toBe(true);
      fs.writeFileSync(t.file, 'x\n'); // Restored with the previous bytes.
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('yx\n');
      expect(t.bridge.state().gone).toBe(false);
    });
  });

  it('a deleted file is not recreated by a save; a later outside write brings it back', async () => {
    const t = await setup('x\n');
    fs.unlinkSync(t.file);
    t.person((x) => x.insert(0, 'y'));
    expect(await t.bridge.save()).toEqual({ ok: false, conflict: 'gone' });
    expect(fs.existsSync(t.file)).toBe(false);
    expect(t.bridge.state().gone).toBe(true);
    fs.writeFileSync(t.file, 'x\nz\n');
    await t.bridge.sync();
    expect(t.bridge.state().gone).toBe(false);
    expect(t.text.toString()).toBe('yx\nz\n');
  });

  describe('net-lead round 3 and org\'s conditions (smartyfs#32)', () => {
    it('a truncate-and-pause is a conflict, not a merge: the room keeps its deletion, and the full write converges', async () => {
      const t = await setup('AB');
      t.person((x) => x.delete(1, 1)); // The room deletes B.
      fs.writeFileSync(t.file, ''); // A writer truncated, and pauses.
      await t.bridge.sync();
      expect(t.text.toString()).toBe('A');
      fs.writeFileSync(t.file, 'C'); // A partial write of 'CB' (net-lead round 4): it removes text, so it is held.
      await t.bridge.sync();
      expect(t.text.toString()).toBe('A');
      fs.writeFileSync(t.file, 'CB'); // Its full write: still removes A, so still held until the person accepts it.
      await t.bridge.sync();
      expect(t.text.toString()).toBe('A');
      expect(t.conflicts.map((c) => c.conflict)).toEqual(['truncated', 'removed', 'removed']);
      await t.bridge.acceptDisk();
      expect(t.text.toString()).toBe('C'); // Theirs (A to C), and the room's deletion of B, both kept.
    });

    it('a truncation the person accepts is merged', async () => {
      const t = await setup('keep me\n');
      fs.writeFileSync(t.file, '');
      await t.bridge.sync();
      expect(t.text.toString()).toBe('keep me\n');
      await t.bridge.acceptDisk();
      expect(t.text.toString()).toBe('');
      expect(t.bridge.state().conflict).toBe(null);
    });

    it('a deleted file restored with the same content is no longer gone', async () => {
      const t = await setup('same\n');
      fs.unlinkSync(t.file);
      await t.bridge.sync();
      expect(t.bridge.state().gone).toBe(true);
      fs.writeFileSync(t.file, 'same\n');
      await t.bridge.sync();
      expect(t.bridge.state().gone).toBe(false);
    });
  });

  it('refuses a file that is not UTF-8 text', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'p'));
    const file = path.join(home, 'p', 'image.bin');
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0xff, 0xfe]));
    const bridge = createDiskBridge({ root: path.join(home, 'p'), file, doc: new Y.Doc(), recoveryDir: path.join(home, 'r'), watch: () => ({ close() {} }), settleMs: 5, enabled: true });
    await expect(bridge.load()).rejects.toThrow(/not UTF-8/);
  });

  it('refuses a file outside its project, or a recovery directory inside it', () => {
    const doc = new Y.Doc();
    expect(() => createDiskBridge({ root: '/a/project', file: '/a/projectx/f', doc, recoveryDir: '/r', enabled: true })).toThrow(/inside/);
    expect(() => createDiskBridge({ root: '/a/project', file: '/a/project', doc, recoveryDir: '/r', enabled: true })).toThrow(/inside/);
    expect(() => createDiskBridge({ root: '/a/project', file: '/a/project/f', doc, recoveryDir: '/a/project/.r', enabled: true })).toThrow(/recovery/);
  });

  it('keeps the file mode (an executable script stays executable)', async () => {
    const t = await setup('#!/bin/sh\n');
    fs.chmodSync(t.file, 0o755);
    t.person((x) => x.insert(10, 'echo hi\n'));
    expect(await t.bridge.save()).toEqual({ ok: true });
    expect(fs.statSync(t.file).mode & 0o777).toBe(0o755);
  });

  it('sees an outside write through the real watcher, including a replace by rename (editors, git checkout)', async () => {
    const { text, file } = await setup('v1\n', { watch: true });
    fs.writeFileSync(`${file}.new`, 'v1\nv2\n');
    fs.renameSync(`${file}.new`, file);
    await expect.poll(() => text.toString(), { timeout: 3000 }).toBe('v1\nv2\n');
  });
});
