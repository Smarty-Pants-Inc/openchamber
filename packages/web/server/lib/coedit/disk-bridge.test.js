import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { createDiskBridge, DISK_ORIGIN, TEXT } from './disk-bridge.js';

const cleanups = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A real project and file, a recovery directory outside it, and a room bridged to the file. */
const setup = async (content = 'hello world\n', { watch = false } = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
  const root = path.join(home, 'project');
  const recoveryDir = path.join(home, 'recovery');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const file = path.join(root, 'src', 'notes.md');
  fs.writeFileSync(file, content);
  const doc = new Y.Doc();
  const hooks = {};
  const conflicts = [];
  const options = { root, file, doc, recoveryDir, hooks, debounceMs: 10, settleMs: 20, onConflict: (c) => conflicts.push(c) };
  if (!watch) options.watch = () => ({ close() {} });
  const bridge = createDiskBridge(options);
  cleanups.push(() => { bridge.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await bridge.load();
  const text = doc.getText(TEXT);
  /** A person's edit in the room (another client's Y.Doc, synced in). */
  const person = (edit) => {
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(other);
    edit(other.getText(TEXT));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, before), 'person');
  };
  /** Runs `fn` once, at the named race point. */
  const at = (point, fn) => { hooks[point] = async (info) => { delete hooks[point]; await fn(info); }; };
  const leftovers = () => fs.readdirSync(path.dirname(file)).filter((entry) => entry.includes('.coedit-'));
  const kept = () => (fs.existsSync(recoveryDir) ? fs.readdirSync(recoveryDir).map((f) => fs.readFileSync(path.join(recoveryDir, f), 'utf8')) : []);
  return { home, root, file, doc, text, bridge, person, at, conflicts, leftovers, kept, recoveryDir, disk: () => fs.readFileSync(file, 'utf8') };
};

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
    expect(t.kept()).toEqual(['a\n']);
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

  describe('races injected at the exact points (net-lead review)', () => {
    for (const [what, race] of [
      ['an in-place write', (t) => fs.appendFileSync(t.file, 'agent\n')],
      ['a replace by rename', (t) => { fs.writeFileSync(`${t.file}.git`, 'base\ncheckout\n'); fs.renameSync(`${t.file}.git`, t.file); }],
      ['a delete', (t) => fs.unlinkSync(t.file)],
    ]) {
      it(`${what} after the staging file exists is a conflict: theirs stays exactly as they left it`, async () => {
        const t = await setup('base\n');
        let theirs = null;
        t.at('beforePublish', () => { race(t); theirs = fs.existsSync(t.file) ? t.disk() : null; });
        t.person((x) => x.insert(0, 'person\n'));
        const result = await t.bridge.save();
        expect(result.ok).toBe(false);
        expect(result.conflict).toBe('changed');
        expect(fs.existsSync(t.file) ? t.disk() : null).toBe(theirs);
        expect(t.leftovers()).toEqual([]);
      });
    }

    it('a staging name swapped for a hardlink to the original is never published', async () => {
      const t = await setup('original\n');
      t.at('beforePublish', ({ staging }) => { fs.unlinkSync(staging); fs.linkSync(t.file, staging); });
      t.person((x) => x.insert(0, 'person\n'));
      const result = await t.bridge.save();
      expect(result).toMatchObject({ ok: false, conflict: 'unverified' });
      expect(t.disk()).toBe('original\n');
    });

    it('a write through an old fd after the check lands in the replaced revision: kept for recovery and shown', async () => {
      const t = await setup('log\n');
      const agentFd = fs.openSync(t.file, 'a'); // An agent holding the file open for appends.
      t.at('afterRename', () => fs.writeSync(agentFd, 'appended\n'));
      t.person((x) => x.insert(0, 'person\n'));
      const result = await t.bridge.save();
      fs.closeSync(agentFd);
      expect(result).toMatchObject({ ok: false, conflict: 'raced' });
      expect(fs.readFileSync(result.recovery, 'utf8')).toBe('log\nappended\n');
      expect(t.disk()).toBe('person\nlog\n');
    });

    it('the directory moved outside the project after the staging file exists: nothing is written or left outside', async () => {
      const t = await setup('inside\n');
      const outside = path.join(t.home, 'moved-out');
      t.at('beforePublish', () => fs.renameSync(path.join(t.root, 'src'), outside));
      t.person((x) => x.insert(0, 'x'));
      await expect(t.bridge.save()).rejects.toThrow(/left its project/);
      expect(fs.readdirSync(outside)).toEqual(['notes.md']);
      expect(fs.readFileSync(path.join(outside, 'notes.md'), 'utf8')).toBe('inside\n');
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

  it('fails closed where paths cannot be anchored to the held directory', async () => {
    const t = await setup('x\n');
    const real = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === '/proc/self/fd' ? false : real(p)));
    t.person((x) => x.insert(0, 'y'));
    await expect(t.bridge.save()).rejects.toThrow(/anchored/);
    expect(t.disk()).toBe('x\n');
  });

  it('merges only settled revisions: a writer still writing is waited out', async () => {
    const { text, file, bridge } = await setup('v1\n');
    const handle = fs.openSync(file, 'w'); // Truncated, then written in pieces.
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
    expect(merged.every((shown) => shown === 'line 0\nline 1\nline 2\nline 3\nline 4\n')).toBe(true);
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

  it('refuses a file that is not UTF-8 text', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'p'));
    const file = path.join(home, 'p', 'image.bin');
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0xff, 0xfe]));
    const bridge = createDiskBridge({ root: path.join(home, 'p'), file, doc: new Y.Doc(), recoveryDir: path.join(home, 'r'), watch: () => ({ close() {} }), settleMs: 5 });
    await expect(bridge.load()).rejects.toThrow(/not UTF-8/);
  });

  it('refuses a file outside its project, or a recovery directory inside it', () => {
    const doc = new Y.Doc();
    expect(() => createDiskBridge({ root: '/a/project', file: '/a/projectx/f', doc, recoveryDir: '/r' })).toThrow();
    expect(() => createDiskBridge({ root: '/a/project', file: '/a/project', doc, recoveryDir: '/r' })).toThrow();
    expect(() => createDiskBridge({ root: '/a/project', file: '/a/project/f', doc, recoveryDir: '/a/project/.r' })).toThrow();
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
    fs.writeFileSync(`${file}.new`, 'v2\n');
    fs.renameSync(`${file}.new`, file);
    await expect.poll(() => text.toString(), { timeout: 3000 }).toBe('v2\n');
  });
});
