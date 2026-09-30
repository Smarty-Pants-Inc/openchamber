// smartyfs#32 / #412: the coedit-fs service under a REAL separate account (not the same-account test override).
// Runs only against a live service: OPENCHAMBER_COEDIT_TEST_SOCKET (its socket), OPENCHAMBER_COEDIT_TEST_BASE (a
// directory of this account whose ancestors already grant the service's account search-only `x`), and setfacl. The
// forge rig (Light's coedit-test units) or Dev1 after smarty-dev#2251 provide one; elsewhere these tests skip.
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createDiskBridge, TEXT } from './disk-bridge.js';
import { hashBytes, keyOf, readFile, startHelper } from './safe-file.js';

const SOCKET = process.env.OPENCHAMBER_COEDIT_TEST_SOCKET ?? '';
const BASE = process.env.OPENCHAMBER_COEDIT_TEST_BASE ?? '';
const live = Boolean(SOCKET && BASE && fs.existsSync(SOCKET) && fs.existsSync(BASE));
/** A third local account the test may run `cat` as (sudoers-limited on the rig), to prove others cannot read. */
const THIRD = process.env.OPENCHAMBER_COEDIT_TEST_READER ?? '';
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
  // The recovery directory: 0700, with the same grant, so the helper can deliver what it recovers (#428).
  const recoveryDir = path.join(home, 'recovery');
  fs.mkdirSync(recoveryDir, { mode: 0o700 });
  execFileSync('setfacl', ['-m', `u:${account}:rwx`, recoveryDir]);
  return { home, root, file: path.join(root, 'docs', 'a.md'), recoveryDir };
};
const bridgeFor = (t, extra = {}) => {
  const doc = new Y.Doc();
  const conflicts = [];
  const bridge = createDiskBridge({ root: t.root, file: t.file, doc, recoveryDir: t.recoveryDir, watch: () => ({ close() {} }), settleMs: 20, retryMs: 50, onConflict: (c) => conflicts.push(c), enabled: true, ...extra });
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

  it('#412 round 2: another connection sees a pending revision only as owned; it cannot take or remove it', async () => {
    const t = setup('log\n');
    const writer = fs.openSync(t.file, 'a');
    const { bridge, doc } = bridgeFor(t);
    await bridge.load();
    doc.getText(TEXT).insert(0, 'P');
    expect(await bridge.save()).toEqual({ ok: true }); // Its displaced revision stays pending: the writer holds it.
    const other = startHelper(t.root, path.join(t.recoveryDir, '.staging'));
    try {
      const { entries } = await other.call({ op: 'list', path: 'docs/a.md' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ owned: true });
      expect(entries[0].data).toBeUndefined();
      expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: entries[0].entry, hash: 'x' })).toMatchObject({ ok: false, owned: true });
    } finally {
      await other.close();
      fs.closeSync(writer);
    }
  });

  it('#412 round 3: a writer\'s own flock on the file cannot take ownership: another connection is still refused', async () => {
    const t = setup('log\n');
    const writer = spawn('python3', ['-c', "import fcntl,sys\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('ready',flush=True)\nsys.stdin.readline()\nf.write('late\\n');f.flush()\nfcntl.flock(f,fcntl.LOCK_UN)\nf.close()", t.file], { stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise((done) => createInterface({ input: writer.stdout }).once('line', done));
    // No automatic retry until the other connection has looked: the owner must still hold the revision then.
    const { bridge, doc, conflicts } = bridgeFor(t, { retryMs: 60_000 });
    await bridge.load();
    doc.getText(TEXT).insert(0, 'P');
    expect(await bridge.save()).toEqual({ ok: true });
    writer.stdin.end('go\n');
    await new Promise((done) => writer.on('exit', done));
    const other = startHelper(t.root, path.join(t.recoveryDir, '.staging'));
    try {
      const { entries } = await other.call({ op: 'list', path: 'docs/a.md' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ owned: true });
    } finally {
      await other.close();
    }
    await bridge.sync(); // Its owner collects it now.
    await expect.poll(() => conflicts.find((c) => c.conflict === 'raced'), { timeout: 5000 }).toBeTruthy();
    expect(fs.readFileSync(conflicts.find((c) => c.conflict === 'raced').recovery, 'utf8')).toBe('log\nlate\n');
  });

  it('#412 round 2: closing proves the service helper quiescent (bye answered)', async () => {
    const t = setup('q\n');
    const { bridge } = bridgeFor(t);
    await bridge.load();
    expect(await bridge.close()).toEqual({ quiescent: true });
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

  it('#412 round 4: a transaction record outlives its connection, and only the secret token acknowledges it', async () => {
    const t = setup('r\n');
    const staging = path.join(t.recoveryDir, '.staging');
    const first = startHelper(t.root, staging);
    try {
      const current = await readFile(first, 'docs/a.md');
      const reply = await first.call({
        op: 'publish', path: 'docs/a.md', txn: 'feed01', ack: hashBytes(Buffer.from('only-mine')), ino: current.ino, dev: current.dev, hash: current.hash, data: Buffer.from('R\n').toString('base64'),
      });
      expect(reply).toMatchObject({ published: true });
    } finally {
      expect(await first.close()).toEqual({ quiescent: true }); // Its connection ends without disposing: an orphan.
    }
    const other = startHelper(t.root, staging);
    try {
      const seen = await other.call({ op: 'list', path: 'docs/a.md' });
      expect(seen.records).toEqual([{ txn: 'feed01', state: 'published', owned: true, orphan: false }]); // Not this caller's to take.
      expect(await other.call({ op: 'ack', path: 'docs/a.md', txn: 'feed01' })).toMatchObject({ ok: false });
      expect(await other.call({ op: 'ack', path: 'docs/a.md', txn: 'feed01', token: 'guess' })).toMatchObject({ ok: false });
      // With the token: its retained data goes first (a claim), then the receipt.
      const mine = await other.call({ op: 'list', path: 'docs/a.md', tokens: { feed01: 'only-mine' } });
      const [entry] = mine.entries;
      expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: entry.entry, hash: entry.hash, token: 'only-mine' })).toMatchObject({ ok: true });
      expect(await other.call({ op: 'ack', path: 'docs/a.md', txn: 'feed01', token: 'only-mine' })).toMatchObject({ ok: true });
      expect((await other.call({ op: 'list', path: 'docs/a.md' })).records).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('#412 round 4: a txn reused on another file grants nothing over this file\'s live transaction', async () => {
    const t = setup('x\n');
    fs.writeFileSync(path.join(t.root, 'docs', 'b.md'), 'y\n');
    const writer = fs.openSync(t.file, 'a');
    const { bridge, doc } = bridgeFor(t);
    await bridge.load();
    doc.getText(TEXT).insert(0, 'P');
    expect(await bridge.save()).toEqual({ ok: true }); // Pending: the writer holds the displaced revision.
    fs.writeSync(writer, 'late\n');
    // The writer stays open through the checks: once it closes, the bridge's own retry may dispose the entry first.
    const other = startHelper(t.root, path.join(t.recoveryDir, '.staging'));
    try {
      const [record] = (await other.call({ op: 'list', path: 'docs/a.md' })).records;
      expect(record).toMatchObject({ owned: true });
      const rb = await readFile(other, 'docs/b.md');
      expect(await other.call({ op: 'publish', path: 'docs/b.md', txn: record.txn, ack: hashBytes(Buffer.from('b')), ino: rb.ino, dev: rb.dev, hash: rb.hash, data: Buffer.from('Y\n').toString('base64') })).toMatchObject({ published: true });
      const seen = await other.call({ op: 'list', path: 'docs/a.md' });
      expect(seen.entries).toHaveLength(1);
      expect(seen.entries[0]).toMatchObject({ owned: true });
      expect(seen.entries[0].data).toBeUndefined();
      expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: seen.entries[0].entry, hash: hashBytes(Buffer.from('x\nlate\n')) })).toMatchObject({ ok: false, owned: true });
      expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: `${keyOf(t.root, 'docs/a.md')}.${record.txn}-bogus.staged`, hash: 'x' })).toMatchObject({ ok: false, owned: true });
    } finally {
      await other.close();
      fs.closeSync(writer);
    }
  });

  it('#412 round 5: after its helper connection is lost, a pending revision stays its bridge\'s; only the token reclaims it', async () => {
    const t = setup('p\n');
    const staging = path.join(t.recoveryDir, '.staging');
    const writer = fs.openSync(t.file, 'a');
    const origin = startHelper(t.root, staging);
    let displaced;
    let hash;
    try {
      const current = await readFile(origin, 'docs/a.md');
      hash = current.hash;
      const reply = await origin.call({
        op: 'publish', path: 'docs/a.md', txn: 'beef02', ack: hashBytes(Buffer.from('mine')), ino: current.ino, dev: current.dev, hash, data: Buffer.from('P\n').toString('base64'),
      });
      displaced = reply.displaced;
      expect(await origin.call({ op: 'dispose', path: 'docs/a.md', entry: displaced, hash })).toMatchObject({ ok: false, busy: true });
    } finally {
      await origin.close(); // Only the helper connection is lost.
    }
    fs.writeSync(writer, 'late\n');
    fs.closeSync(writer);
    const other = startHelper(t.root, staging);
    try {
      expect((await other.call({ op: 'list', path: 'docs/a.md' })).entries).toEqual([{ entry: displaced, owned: true }]);
      expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: displaced, hash: hashBytes(Buffer.from('p\nlate\n')) })).toMatchObject({ ok: false, owned: true });
    } finally {
      await other.close();
    }
    const again = startHelper(t.root, staging); // The bridge reconnects, with its token.
    try {
      expect(await again.call({ op: 'dispose', path: 'docs/a.md', entry: displaced, hash, token: 'mine' })).toMatchObject({ ok: false, changed: true, hash: hashBytes(Buffer.from('p\nlate\n')) });
    } finally {
      await again.close();
    }
  });

  it('#412 round 6: reusing a live transaction\'s id on the same file is refused, and its record stays exactly as it was', async () => {
    const t = setup('d\n');
    const staging = path.join(t.recoveryDir, '.staging');
    const writer = fs.openSync(t.file, 'a');
    const origin = startHelper(t.root, staging);
    const other = startHelper(t.root, staging);
    try {
      const current = await readFile(origin, 'docs/a.md');
      const reply = await origin.call({
        op: 'publish', path: 'docs/a.md', txn: 'dead01', ack: hashBytes(Buffer.from('mine')), ino: current.ino, dev: current.dev, hash: current.hash, data: Buffer.from('D\n').toString('base64'),
      });
      expect(reply).toMatchObject({ published: true });
      const now = await readFile(other, 'docs/a.md');
      const dup = await other.call({
        op: 'publish', path: 'docs/a.md', txn: 'dead01', ack: hashBytes(Buffer.from('theirs')), ino: now.ino, dev: now.dev, hash: now.hash, data: Buffer.from('X\n').toString('base64'),
      });
      expect(dup).toMatchObject({ ok: false, error: expect.stringMatching(/already in use/) });
      expect((await other.call({ op: 'list', path: 'docs/a.md' })).records).toEqual([{ txn: 'dead01', owned: true }]);
      expect(fs.readFileSync(t.file, 'utf8')).toBe('D\n');
    } finally {
      fs.closeSync(writer);
      await other.close();
      await origin.close();
    }
  });

  it('#428: after the originating process exits, an unrelated tokenless connection gets nothing; the helper delivers the late bytes to the restarted bridge', async () => {
    const t = setup('o\n');
    const staging = path.join(t.recoveryDir, '.staging');
    const writer = fs.openSync(t.file, 'a');
    const probe = startHelper(t.root, staging);
    const current = await readFile(probe, 'docs/a.md');
    await probe.close();
    // The server before its restart: its own connection to the service publishes, then the process exits.
    const origin = spawnSync(process.execPath, ['-e', `
      const c = require('net').createConnection(process.argv[1]);
      const rl = require('readline').createInterface({ input: c });
      const out = [];
      rl.on('line', (l) => { out.push(l); if (out.length === 2) { console.log(l); process.exit(0); } });
      c.write(JSON.stringify({ op: 'hello', root: process.argv[2], recovery: process.argv[4], id: 1 }) + '\\n');
      c.write(process.argv[3] + '\\n');
    `, SOCKET, t.root, JSON.stringify({ op: 'publish', path: 'docs/a.md', txn: 'c0ffee', ack: hashBytes(Buffer.from('gone')), ino: current.ino, dev: current.dev, hash: current.hash, data: Buffer.from('O\n').toString('base64'), id: 2 }), t.recoveryDir], { encoding: 'utf8', timeout: 30_000 });
    const reply = JSON.parse(origin.stdout.trim());
    expect(reply).toMatchObject({ published: true });
    await new Promise((done) => setTimeout(done, 500)); // Its helper reads EOF and exits.
    fs.writeSync(writer, 'late\n');
    fs.closeSync(writer);
    // An unrelated process of the same account, with no token, names ITS OWN recovery directory, and races the
    // restarted bridge (#428 round 2): nothing may be delivered there.
    const theirs = path.join(t.home, 'theirs');
    fs.mkdirSync(theirs, { mode: 0o700 });
    execFileSync('setfacl', ['-m', `u:${process.env.OPENCHAMBER_COEDIT_TEST_ACCOUNT ?? 'coedit-test'}:rwx`, theirs]);
    const other = startHelper(t.root, path.join(theirs, '.staging'));
    try {
      const seen = await other.call({ op: 'list', path: 'docs/a.md' });
      expect(JSON.stringify(seen)).not.toContain(Buffer.from('o\nlate\n').toString('base64')); // No bytes.
      expect(seen.entries.every((e) => e.owned || e.data === undefined)).toBe(true);
      // Its dispose is refused: only the helper recovers an orphan, and it already has.
      expect((await other.call({ op: 'dispose', path: 'docs/a.md', entry: reply.displaced, hash: hashBytes(Buffer.from('o\nlate\n')) })).ok).toBe(false);
      expect(seen.recovered).toEqual([{ marker: expect.any(String), path: expect.stringContaining(t.recoveryDir), hash: hashBytes(Buffer.from('o\nlate\n')) }]);
      expect(fs.readdirSync(theirs).filter((n) => n !== '.staging')).toEqual([]); // No bytes in the caller's directory.
      // The delivered copy is private: the served account reads it; a third account cannot (#428 round 2).
      const copy = seen.recovered[0].path;
      expect(fs.readFileSync(copy, 'utf8')).toBe('o\nlate\n');
      if (THIRD) {
        const third = spawnSync('sudo', ['-n', '-u', THIRD, '/usr/bin/cat', copy], { encoding: 'utf8' });
        expect(third.status).not.toBe(0);
        expect(third.stdout).toBe('');
      }
    } finally {
      await other.close();
    }
    // The restarted server's bridge loads: the late bytes are in its recovery directory, shown once.
    const { bridge, conflicts } = bridgeFor(t);
    await bridge.load();
    const raced = conflicts.filter((c) => c.conflict === 'raced');
    expect(raced).toHaveLength(1);
    expect(fs.readFileSync(raced[0].recovery, 'utf8')).toBe('o\nlate\n');
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
