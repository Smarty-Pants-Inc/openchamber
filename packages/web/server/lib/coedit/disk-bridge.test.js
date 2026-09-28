import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createDiskBridge, DISK_ORIGIN, TEXT } from './disk-bridge.js';

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A real project directory and file, and a room bridged to it (no watcher unless asked: tests call sync()). */
const setup = async (content = 'hello world\n', { watch = false, hooks } = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
  const root = path.join(home, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const file = path.join(root, 'src', 'notes.md');
  fs.writeFileSync(file, content);
  const doc = new Y.Doc();
  const options = { root, file, doc, debounceMs: 10 };
  if (hooks) options.hooks = hooks;
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
  const leftovers = () => fs.readdirSync(path.dirname(file)).filter((entry) => entry.includes('.coedit-'));
  return { home, root, file, doc, text, bridge, person, leftovers, disk: () => fs.readFileSync(file, 'utf8') };
};
/** Hooks filled in after setup (they need the setup's paths). */
const lateHooks = () => {
  const hooks = {};
  return { hooks, set: (name, fn) => { let done = false; hooks[name] = async () => { if (!done) { done = true; await fn(); } }; } };
};

describe('co-edit disk bridge (smartyfs#18)', () => {
  it('loads the file into the room', async () => {
    const { text, bridge } = await setup('line one\nline two\n');
    expect(text.toString()).toBe('line one\nline two\n');
    expect(bridge.state()).toEqual({ gone: false, loaded: true });
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

  it('saves the room to disk, and its own write is not merged back', async () => {
    const { text, bridge, person, disk, leftovers } = await setup('a\n');
    person((t) => t.insert(1, 'b'));
    expect(await bridge.save()).toEqual({ ok: true });
    expect(disk()).toBe('ab\n');
    await bridge.sync();
    expect(text.toString()).toBe('ab\n');
    expect(leftovers()).toEqual([]);
  });

  it('a stale save merges the outside write first, so neither side is lost', async () => {
    const { text, file, bridge, person, disk } = await setup('one\ntwo\nthree\n');
    person((t) => t.insert(0, 'zero\n')); // Kate, in the room.
    fs.writeFileSync(file, 'one\ntwo\nthree\nfour\n'); // An agent, on disk, not yet seen.
    expect(await bridge.save()).toEqual({ ok: true });
    expect(disk()).toBe('zero\none\ntwo\nthree\nfour\n');
    expect(text.toString()).toBe(disk());
  });

  describe('races injected at the exact points (net-lead review)', () => {
    it('an outside write between the check and the swap is merged and saved, never overwritten', async () => {
      const late = lateHooks();
      const t = await setup('base\n', { hooks: late.hooks });
      late.set('beforeSwap', () => fs.appendFileSync(t.file, 'agent\n'));
      t.person((x) => x.insert(0, 'person\n'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('person\nbase\nagent\n');
      expect(t.text.toString()).toBe(t.disk());
      expect(t.leftovers()).toEqual([]);
    });

    it('a replace by rename between the check and the swap is merged, not overwritten', async () => {
      const late = lateHooks();
      const t = await setup('base\n', { hooks: late.hooks });
      late.set('beforeSwap', () => { fs.writeFileSync(`${t.file}.git`, 'base\ncheckout\n'); fs.renameSync(`${t.file}.git`, t.file); });
      t.person((x) => x.insert(0, 'person\n'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('person\nbase\ncheckout\n');
    });

    it('a delete between the check and the swap is not undone: the save reports gone', async () => {
      const late = lateHooks();
      const t = await setup('base\n', { hooks: late.hooks });
      late.set('beforeSwap', () => fs.unlinkSync(t.file));
      t.person((x) => x.insert(0, 'person\n'));
      expect(await t.bridge.save()).toEqual({ ok: false, reason: 'gone' });
      expect(fs.existsSync(t.file)).toBe(false);
      expect(t.leftovers()).toEqual([]);
    });

    it('a file created at the path after the old one moved aside wins; it is merged, then saved', async () => {
      const late = lateHooks();
      const t = await setup('base\n', { hooks: late.hooks });
      late.set('beforeLink', () => fs.writeFileSync(t.file, 'base\nnew by agent\n', { flag: 'wx' }));
      t.person((x) => x.insert(0, 'person\n'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      expect(t.disk()).toBe('person\nbase\nnew by agent\n');
    });

    it('an append through an old fd during the swap is caught and merged, never lost', async () => {
      const late = lateHooks();
      const t = await setup('log\n', { hooks: late.hooks });
      const agentFd = fs.openSync(t.file, 'a'); // An agent holding the file open for appends.
      late.set('beforeLink', () => { fs.writeSync(agentFd, 'appended\n'); });
      t.person((x) => x.insert(0, 'person\n'));
      expect(await t.bridge.save()).toEqual({ ok: true });
      fs.closeSync(agentFd);
      expect(t.disk()).toBe('person\nlog\nappended\n');
      expect(t.text.toString()).toBe(t.disk());
    });

    it('a directory swapped for a link to outside, after the temp file exists, writes nothing outside the project', async () => {
      const late = lateHooks();
      const t = await setup('inside\n', { hooks: late.hooks });
      const elsewhere = path.join(t.home, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, 'notes.md'), 'other\n');
      late.set('afterTemp', () => {
        fs.renameSync(path.join(t.root, 'src'), path.join(t.root, 'src-real'));
        fs.symlinkSync(elsewhere, path.join(t.root, 'src'));
      });
      t.person((x) => x.insert(0, 'x'));
      await expect(t.bridge.save()).rejects.toThrow(/left its project/);
      expect(fs.readdirSync(elsewhere)).toEqual(['notes.md']);
      expect(fs.readFileSync(path.join(elsewhere, 'notes.md'), 'utf8')).toBe('other\n');
      expect(fs.readdirSync(path.join(t.root, 'src-real')).filter((e) => e.includes('.coedit-'))).toEqual([]);
    });
  });

  it('merges only completed revisions: a writer still writing is waited out, and a paused one converges', async () => {
    const { text, file, bridge } = await setup('v1\n');
    const handle = fs.openSync(file, 'w'); // Truncated, then written in pieces.
    fs.writeSync(handle, 'v2 part one\n');
    const writing = (async () => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((done) => setTimeout(done, 5));
        fs.writeSync(handle, `line ${i}\n`);
      }
    })();
    await bridge.sync();
    await writing;
    fs.closeSync(handle);
    await bridge.sync();
    expect(text.toString()).toBe(fs.readFileSync(file, 'utf8'));
  });

  it('refuses a file that is not UTF-8 text', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, 'image.bin');
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0xff, 0xfe]));
    const bridge = createDiskBridge({ root: home, file, doc: new Y.Doc(), watch: () => ({ close() {} }) });
    await expect(bridge.load()).rejects.toThrow(/not UTF-8/);
  });

  it('a deleted file is not recreated by a save; a later outside write brings it back', async () => {
    const { text, file, bridge, person } = await setup('x\n');
    fs.unlinkSync(file);
    person((t) => t.insert(0, 'y'));
    expect(await bridge.save()).toEqual({ ok: false, reason: 'gone' });
    expect(fs.existsSync(file)).toBe(false);
    expect(bridge.state().gone).toBe(true);
    fs.writeFileSync(file, 'x\nz\n');
    await bridge.sync();
    expect(bridge.state().gone).toBe(false);
    expect(text.toString()).toBe('yx\nz\n');
  });

  it('never writes outside the project: a file swapped for a link, or its directory, is refused', async () => {
    const { home, file, bridge, person, root } = await setup('inside\n');
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, 'secret\n');
    fs.unlinkSync(file);
    fs.symlinkSync(outside, file);
    person((t) => t.insert(0, 'x'));
    await expect(bridge.save()).rejects.toThrow(/link/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret\n');
    fs.unlinkSync(file);
    fs.renameSync(path.join(root, 'src'), path.join(root, 'src-real'));
    fs.mkdirSync(path.join(home, 'elsewhere'));
    fs.writeFileSync(path.join(home, 'elsewhere', 'notes.md'), 'other\n');
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(root, 'src'));
    await expect(bridge.save()).rejects.toThrow(/left its project/);
    expect(fs.readFileSync(path.join(home, 'elsewhere', 'notes.md'), 'utf8')).toBe('other\n');
  });

  it('refuses a file outside its project root', () => {
    expect(() => createDiskBridge({ root: '/a/project', file: '/a/projectx/f', doc: new Y.Doc() })).toThrow();
    expect(() => createDiskBridge({ root: '/a/project', file: '/a/project', doc: new Y.Doc() })).toThrow();
  });

  it('keeps the file mode (an executable script stays executable)', async () => {
    const { file, bridge, person } = await setup('#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
    await bridge.sync(); // The mode change is a new revision (same text).
    person((t) => t.insert(10, 'echo hi\n'));
    expect(await bridge.save()).toEqual({ ok: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
  });

  it('sees an outside write through the real watcher, including a replace by rename (editors, git checkout)', async () => {
    const { text, file } = await setup('v1\n', { watch: true });
    const tmp = `${file}.new`;
    fs.writeFileSync(tmp, 'v2\n');
    fs.renameSync(tmp, file);
    await expect.poll(() => text.toString(), { timeout: 3000 }).toBe('v2\n');
  });
});
