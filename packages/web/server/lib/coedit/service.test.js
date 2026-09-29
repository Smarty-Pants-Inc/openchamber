// smartyfs#32 / #412: the coedit-fs service under a REAL separate account (not the same-account test override).
// Runs only against a live service: OPENCHAMBER_COEDIT_TEST_SOCKET (its socket), OPENCHAMBER_COEDIT_TEST_BASE (a
// directory of this account whose ancestors already grant the service's account search-only `x`), and setfacl. The
// forge rig (Light's coedit-test units) or Dev1 after smarty-dev#2251 provide one; elsewhere these tests skip.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createDiskBridge, TEXT } from './disk-bridge.js';
import { hashBytes, keyOf, readFile, startHelper } from './safe-file.js';

const SOCKET = process.env.OPENCHAMBER_COEDIT_TEST_SOCKET ?? '';
const BASE = process.env.OPENCHAMBER_COEDIT_TEST_BASE ?? '';
const live = Boolean(SOCKET && BASE && fs.existsSync(SOCKET) && fs.existsSync(BASE));
const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The service's account: the owner of a file it published (found by a first save). */
const setup = (content) => {
  const home = fs.mkdtempSync(path.join(BASE, 'svc-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'project');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), content);
  // The per-root grant, as the root's owner makes it (DOCUMENTATION.md, Setup); `home` needs search only.
  const account = process.env.OPENCHAMBER_COEDIT_TEST_ACCOUNT ?? 'coedit-test';
  execFileSync('setfacl', ['-m', `u:${account}:x`, home]);
  execFileSync('setfacl', ['-R', '-m', `u:${account}:rwX`, '-m', `d:u:${account}:rwX`, root]);
  return { home, root, file: path.join(root, 'docs', 'a.md'), recoveryDir: path.join(home, 'recovery') };
};
const bridgeFor = (t) => {
  const doc = new Y.Doc();
  const conflicts = [];
  const bridge = createDiskBridge({ root: t.root, file: t.file, doc, recoveryDir: t.recoveryDir, watch: () => ({ close() {} }), settleMs: 20, retryMs: 50, onConflict: (c) => conflicts.push(c), enabled: true });
  cleanups.unshift(() => void bridge.close());
  return { bridge, doc, conflicts };
};

describe.skipIf(!live)('the coedit-fs service under its own account (smartyfs#32, #412)', () => {
  let saved;
  beforeAll(() => {
    saved = process.env.OPENCHAMBER_COEDIT_SOCKET;
    process.env.OPENCHAMBER_COEDIT_SOCKET = SOCKET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.OPENCHAMBER_COEDIT_SOCKET;
    else process.env.OPENCHAMBER_COEDIT_SOCKET = saved;
    fs.rmSync(path.join(BASE, 'unused'), { recursive: true, force: true });
  });

  it('a save over this account\'s file: published by the service\'s account, and this account keeps read and write', async () => {
    const t = setup('a\n');
    const { bridge, doc } = bridgeFor(t);
    await bridge.load();
    doc.getText(TEXT).insert(0, 'P');
    expect(await bridge.save()).toEqual({ ok: true });
    expect(fs.readFileSync(t.file, 'utf8')).toBe('Pa\n');
    const st = fs.statSync(t.file);
    expect(st.uid).not.toBe(process.geteuid()); // Owned by the service's account (no CAP_CHOWN).
    fs.accessSync(t.file, fs.constants.R_OK | fs.constants.W_OK); // Still ours to read and write, through the ACL.
    fs.appendFileSync(t.file, 'mine\n');
    expect(fs.readFileSync(t.file, 'utf8')).toBe('Pa\nmine\n');
  });

  it('#412 finding 4: the displaced revision (this account\'s inode) is leased and removed; nothing is left pending', async () => {
    const t = setup('a\n');
    const { bridge, doc, conflicts } = bridgeFor(t);
    await bridge.load();
    doc.getText(TEXT).insert(0, 'P');
    expect(await bridge.save()).toEqual({ ok: true }); // A refused lease would leave it pending and never 'ok'-cleaned.
    await bridge.sync();
    expect(conflicts).toEqual([]);
    // A second connection lists this file's private entries: none left (the service's own staging is unreadable here).
    const helper = startHelper(t.root, path.join(t.recoveryDir, '.staging'));
    try {
      expect((await helper.call({ op: 'list', path: 'docs/a.md' })).entries).toEqual([]);
    } finally {
      await helper.close();
    }
  });

  it('#412 finding 4: an old descriptor writing into the displaced revision: busy while open, then kept and shown', async () => {
    const t = setup('log\n');
    const writer = fs.openSync(t.file, 'a');
    const { bridge, doc, conflicts } = bridgeFor(t);
    await bridge.load();
    doc.getText(TEXT).insert(0, 'P');
    expect(await bridge.save()).toEqual({ ok: true });
    fs.writeSync(writer, 'late\n');
    fs.closeSync(writer);
    await expect.poll(() => conflicts.find((c) => c.conflict === 'raced'), { timeout: 5000 }).toBeTruthy();
    expect(fs.readFileSync(conflicts.find((c) => c.conflict === 'raced').recovery, 'utf8')).toBe('log\nlate\n');
  });

  it('#412 finding 1: a root that is not this account\'s (the service\'s own dirs, /) is refused at hello', async () => {
    for (const root of ['/', '/var/lib', path.dirname(SOCKET)]) {
      const helper = startHelper(root, path.join(BASE, 'unused', '.staging'));
      try {
        await expect(helper.call({ op: 'read', path: 'x' })).rejects.toThrow(/project root/);
      } finally {
        await helper.close();
      }
    }
  });

  it('keys agree: the service names entries by sha256(root NUL path), as the bridge does', async () => {
    const t = setup('k\n');
    const helper = startHelper(t.root, path.join(t.recoveryDir, '.staging'));
    try {
      const current = await readFile(helper, 'docs/a.md');
      expect(current.hash).toBe(hashBytes(Buffer.from('k\n')));
      const reply = await helper.call({
        op: 'publish', path: 'docs/a.md', ino: current.ino, dev: current.dev, hash: current.hash, data: Buffer.from('K\n').toString('base64'),
      });
      expect(reply.displaced.startsWith(`${keyOf(t.root, 'docs/a.md')}.`)).toBe(true);
    } finally {
      await helper.close();
    }
  });
});
