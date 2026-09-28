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
const setup = async (content = 'hello world\n', { watch = false, fsPromises } = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-')));
  const root = path.join(home, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const file = path.join(root, 'src', 'notes.md');
  fs.writeFileSync(file, content);
  const doc = new Y.Doc();
  const options = { root, file, doc, debounceMs: 10 };
  if (fsPromises) options.fsPromises = fsPromises(file);
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
  return { home, root, file, doc, text, bridge, person, disk: () => fs.readFileSync(file, 'utf8') };
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
    const { text, bridge, person, disk } = await setup('a\n');
    person((t) => t.insert(1, 'b'));
    expect(await bridge.save()).toEqual({ ok: true });
    expect(disk()).toBe('ab\n');
    await bridge.sync();
    expect(text.toString()).toBe('ab\n');
  });

  it('a stale save merges the outside write first, so neither side is lost', async () => {
    const { text, file, bridge, person, disk } = await setup('one\ntwo\nthree\n');
    person((t) => t.insert(0, 'zero\n')); // Kate, in the room.
    fs.writeFileSync(file, 'one\ntwo\nthree\nfour\n'); // An agent, on disk, not yet seen.
    expect(await bridge.save()).toEqual({ ok: true });
    expect(disk()).toBe('zero\none\ntwo\nthree\nfour\n');
    expect(text.toString()).toBe(disk());
  });

  it('an outside write that lands while the save is writing is merged and saved again, not overwritten', async () => {
    let raced = false;
    const fsPromises = (file) => ({
      ...fs.promises,
      writeFile: async (target, ...rest) => {
        await fs.promises.writeFile(target, ...rest);
        if (!raced && String(target).includes('.coedit-')) {
          raced = true;
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'agent\n'); // Between the check and the rename.
        }
      },
    });
    const { text, bridge, person, disk, file } = await setup('base\n', { fsPromises });
    person((t) => t.insert(0, 'person\n'));
    expect(await bridge.save()).toEqual({ ok: true });
    expect(disk()).toBe('person\nbase\nagent\n');
    expect(text.toString()).toBe(disk());
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.coedit-'))).toEqual([]);
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

  it('never writes outside the project: a file swapped for a link is refused, and so is a directory link', async () => {
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
