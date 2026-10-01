// openchamber#380: the coedit-fs helper against a real Linux filesystem (protocol: coedit DOCUMENTATION.md).
// Builds the helper first (ensure-built.js); without cargo they skip locally and fail in CI.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

import { ensureHelper } from './ensure-built.js';

const BIN = path.join(import.meta.dirname, 'target/release/coedit-fs');
const built = ensureHelper() && fs.existsSync(BIN);
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** POSIX ACL xattrs (acl(5)), through python3's os.setxattr: Node has no xattr calls and hosts may lack setfacl. */
const ACL = { USER_OBJ: 1, USER: 2, GROUP_OBJ: 4, MASK: 0x10, OTHER: 0x20 };
const ANY = 0xffffffff;
const py = (code, ...args) => {
  const r = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const setAcl = (p, name, entries) => py(
  'import os,struct,sys,json\nb=struct.pack("<I",2)+b"".join(struct.pack("<HHI",*e) for e in json.loads(sys.argv[3]))\nos.setxattr(sys.argv[1],sys.argv[2],b)',
  p, name, JSON.stringify(entries),
);
const getXattr = (p, name) => py('import os,sys\ntry: print(os.getxattr(sys.argv[1],sys.argv[2]).hex())\nexcept OSError: print("none")', p, name);
/** An extended ACL: our user, another account (uid 4242) with `perm`, our group r-x, mask rwx. */
const extended = (perm) => [[ACL.USER_OBJ, 7, ANY], [ACL.USER, perm, 4242], [ACL.GROUP_OBJ, 5, ANY], [ACL.MASK, 7, ANY], [ACL.OTHER, 0, ANY]];

function helper(root, priv) {
  const child = spawn(BIN, ['--same-account', root, priv], { env: { ...process.env, COEDIT_FS_TEST: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('close', resolve));
  const waiting = new Map();
  let next = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  const call = (req) => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
  });
  const raw = (line) => new Promise((resolve) => {
    createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l)));
    child.stdin.write(`${line}\n`);
  });
  return { call, raw, finish: () => { child.stdin.end(); return exited; }, stop: () => { child.kill(); return exited; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond) => {
  for (let i = 0; i < 250 && !cond(); i += 1) await sleep(20);
  expect(cond()).toBe(true);
};

describe.skipIf(!built)('coedit-fs (openchamber#380)', () => {
  let dir, root, priv, h, KEY;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-fs-'));
    root = path.join(dir, 'project');
    priv = path.join(dir, 'recovery/.staging');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(priv, { recursive: true });
    fs.chmodSync(priv, 0o700);
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'one\n');
    KEY = sha(`${root}\0docs/a.md`).slice(0, 16); // The helper computes it from the admitted root (#412).
    h = helper(root, priv);
  });
  afterEach(async () => { await h.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  const target = () => path.join(root, 'docs/a.md');
  const docs = () => fs.readdirSync(path.join(root, 'docs')).sort();
  const staged = () => fs.readdirSync(priv).filter((n) => !n.endsWith('-lock') && !n.endsWith('.txn') && !n.endsWith('.out') && !n.endsWith('.done') && !n.endsWith('.anchor')); // Evidence and private delivery anchors are not entries.
  const read = async () => {
    const r = await h.call({ op: 'read', path: 'docs/a.md' });
    expect(r.ok).toBe(true);
    expect(Buffer.from(r.data, 'base64').toString()).toBe('one\n');
    expect(r.hash).toBe(sha('one\n'));
    return r;
  };
  const publish = (r, extra = {}) =>
    h.call({ op: 'publish', path: 'docs/a.md', ino: r.ino, dev: r.dev, hash: r.hash, data: Buffer.from('two\n').toString('base64'), ...extra });
  const dispose = (entry, hash) => h.call({ op: 'dispose', path: 'docs/a.md', entry, hash });
  const replace = (text) => {
    fs.writeFileSync(path.join(root, 'docs/e.tmp'), text);
    fs.renameSync(path.join(root, 'docs/e.tmp'), target());
  };

  describe('#481 repeated disposal completion', () => {
    beforeEach(() => { h.stop = h.finish; }); // New cases close only their own helper, by EOF, even on failure.
    const claimedReceipt = async (token = 'origin-secret') => {
      const r = await read();
      const extra = { txn: 'aaa111' }; if (token !== null) extra.ack = sha(token);
      const p = await publish(r, extra);
      expect(p).toMatchObject({ ok: true, published: true });
      expect(fs.readFileSync(path.join(priv, p.displaced), 'utf8')).toBe('one\n');
      const record = path.join(priv, `${KEY}.aaa111.txn`);
      expect(JSON.parse(fs.readFileSync(record)).ack).toBe(token === null ? '' : sha(token));
      await h.finish();
      const req = { op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: r.hash };
      if (token !== null) req.token = token;
      const claimant = helper(root, priv);
      try { expect(await claimant.call(req)).toMatchObject({ ok: true }); }
      finally { await claimant.finish(); }
      expect(fs.existsSync(path.join(priv, p.displaced))).toBe(false);
      expect(fs.existsSync(record)).toBe(true);
      expect(fs.readFileSync(path.join(priv, `${KEY}.aaa111.out`), 'utf8')).toBe('published');
      return { req, record, token };
    };

    test('lost first dispose reply: H1 publish/EOF, H2 claim/dispose/EOF, H3 identical dispose then ack', async () => {
      const t = await claimedReceipt(); // The first successful dispose reply is not used to settle the origin.
      const next = helper(root, priv);
      try {
        expect(await next.call({ op: 'hello' })).toMatchObject({ ok: true, protocol: 3 });
        expect(await next.call({ op: 'list', path: 'docs/a.md', tokens: { aaa111: t.token } })).toMatchObject({ ok: true, entries: [], records: [{ txn: 'aaa111', state: 'published' }] });
        const repeated = await next.call(t.req);
        const ack = await next.call({ op: 'ack', path: 'docs/a.md', txn: 'aaa111', token: t.token });
        expect(repeated).toMatchObject({ ok: true });
        expect(ack).toMatchObject({ ok: true, pending: false }); // No synthetic absent-entry owner may retain the lock.
        expect(fs.existsSync(t.record)).toBe(false);
        expect(fs.existsSync(path.join(priv, `${KEY}.aaa111.out`))).toBe(false);
      } finally { await next.finish(); }
    });

    test('same claiming connection can repeat disposal and ack without a retained lock', async () => {
      const r = await read(); const p = await publish(r, { txn: 'aaa111', ack: sha('secret') });
      expect(p).toMatchObject({ ok: true, published: true }); await h.finish();
      const next = helper(root, priv);
      try {
        const req = { op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: r.hash, token: 'secret' };
        expect(await next.call(req)).toMatchObject({ ok: true });
        expect(await next.call(req)).toMatchObject({ ok: true });
        expect(await next.call({ op: 'ack', path: 'docs/a.md', txn: 'aaa111', token: 'secret' })).toMatchObject({ ok: true, pending: false });
      } finally { await next.finish(); }
    });

    test('absent data does not grant wrong or missing token authority', async () => {
      const t = await claimedReceipt(); const next = helper(root, priv);
      try {
        expect(await next.call({ ...t.req, token: 'wrong' })).toMatchObject({ ok: false, owned: true });
        const req = { ...t.req }; delete req.token;
        expect(await next.call(req)).toMatchObject({ ok: false, owned: true });
        expect(fs.existsSync(t.record)).toBe(true);
      } finally { await next.finish(); }
    });

    test.each(['txn', 'out', 'done', 'other-txn'])('absent data with malformed %s refuses before authority; unrelated key is unaffected', async (kind) => {
      const t = await claimedReceipt();
      if (kind === 'txn') { const record = JSON.parse(fs.readFileSync(t.record)); delete record.ack; fs.writeFileSync(t.record, JSON.stringify(record)); }
      if (kind === 'out') fs.writeFileSync(path.join(priv, `${KEY}.aaa111.out`), 'invalid');
      if (kind === 'done') fs.writeFileSync(path.join(priv, `${KEY}.aaa111.${sha('one\n').slice(0, 16)}.done`), '{}', { mode: 0o600 });
      if (kind === 'other-txn') fs.writeFileSync(path.join(priv, `${KEY}.bbb222.txn`), '{}', { mode: 0o600 });
      const next = helper(root, priv);
      try {
        expect(await next.call(t.req)).toMatchObject({ ok: false, error: expect.stringMatching(/metadata/) });
        if (kind === 'txn') expect(await next.call({ ...t.req, token: 'wrong' })).toMatchObject({ ok: false, error: expect.stringMatching(/metadata/) });
        expect(await next.call({ op: 'ack', path: 'docs/a.md', txn: 'aaa111', token: t.token })).toMatchObject({ ok: false });
        expect(await next.call({ op: 'list', path: 'docs/b.md' })).toMatchObject({ ok: true, entries: [], records: [] });
        expect(fs.existsSync(t.record)).toBe(true);
      } finally { await next.finish(); }
    });

    test('absence still requires durable outcome; a non-ENOENT stat error cannot acquire ownership', async () => {
      const t = await claimedReceipt(); const next = helper(root, priv);
      try {
        expect(await next.call({ ...t.req, fault: 'recordSync' })).toMatchObject({ ok: false, error: expect.stringMatching(/durable/) });
        expect(await next.call({ ...t.req, entry: `${KEY}.aaa111-${'x'.repeat(300)}.staged` })).toMatchObject({ ok: false, error: expect.stringMatching(/stat/) });
        expect(await next.call({ op: 'ack', path: 'docs/a.md', txn: 'aaa111', token: t.token })).toMatchObject({ ok: true, pending: false });
      } finally { await next.finish(); }
    });

    test('an owned exact absent entry completes, but another absent name cannot impersonate it', async () => {
      const r = await read(); const p = await publish(r, { txn: 'aaa111', ack: sha('secret') });
      expect(p).toMatchObject({ ok: true, published: true }); fs.unlinkSync(path.join(priv, p.displaced));
      expect(await dispose(`${KEY}.aaa111-bogus.staged`, r.hash)).toMatchObject({ ok: false });
      expect(fs.existsSync(path.join(priv, `${KEY}.aaa111.txn`))).toBe(true);
      expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: true });
      expect(fs.existsSync(path.join(priv, `${KEY}.aaa111.txn`))).toBe(false);
      await h.finish();
    });

    test('explicit tokenless duplicate succeeds without making its receipt token-ackable', async () => {
      const t = await claimedReceipt(null); const next = helper(root, priv);
      try {
        expect(await next.call(t.req)).toMatchObject({ ok: true });
        expect(await next.call({ op: 'ack', path: 'docs/a.md', txn: 'aaa111', token: 'wrong' })).toMatchObject({ ok: false, error: "not this transaction's owner" });
        expect(fs.existsSync(t.record)).toBe(true);
      } finally { await next.finish(); }
    });
  });

  test('a plain publish installs ours and keeps the displaced revision in the private dir until disposed', async () => {
    const r = await read();
    const p = await publish(r);
    expect(p).toMatchObject({ ok: true, published: true });
    expect(p.uncertain).toBeUndefined();
    expect(fs.readFileSync(target(), 'utf8')).toBe('two\n');
    expect(fs.statSync(target()).ino).toBe(p.ino);
    expect(p.displaced.startsWith(`${KEY}.`)).toBe(true);
    expect(fs.readFileSync(path.join(priv, p.displaced), 'utf8')).toBe('one\n');
    expect(fs.statSync(path.join(priv, p.displaced)).ino).toBe(r.ino);
    expect(docs()).toEqual(['a.md']);
    expect(await h.call({ op: 'list', path: 'docs/a.md' })).toMatchObject({ ok: true, entries: [{ entry: p.displaced, hash: sha('one\n') }] });
    expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: true });
    expect(staged()).toEqual([]);
  });

  test('replacement after the exchange: E survives, nothing is deleted or undone, published and uncertain', async () => {
    const r = await read();
    const pending = publish(r, { pause: 'afterExchange', pauseMs: 2000 });
    await until(() => fs.readFileSync(target(), 'utf8') === 'two\n');
    expect(docs()).toEqual(['a.md']); // No staging name in the project, even mid-publish.
    replace('E\n');
    const p = await pending;
    expect(p).toMatchObject({ ok: false, published: true });
    expect(p.uncertain).toBeTruthy();
    expect(fs.readFileSync(target(), 'utf8')).toBe('E\n');
    expect(docs()).toEqual(['a.md']);
    expect(fs.readFileSync(path.join(priv, p.displaced), 'utf8')).toBe('one\n');
  });

  test('replacement before the exchange: raced, E intact in the private dir, no staging name in the project', async () => {
    const r = await read();
    const pending = publish(r, { pause: 'beforeExchange', pauseMs: 2000 });
    await until(() => staged().some((n) => n.endsWith('.staged')));
    expect(docs()).toEqual(['a.md']);
    replace('E\n');
    const p = await pending;
    expect(p).toMatchObject({ ok: false, published: true, conflict: 'raced' });
    expect(fs.readFileSync(path.join(priv, p.displaced), 'utf8')).toBe('E\n');
    expect(fs.readFileSync(target(), 'utf8')).toBe('two\n');
    expect(docs()).toEqual(['a.md']);
    // The late copy is kept by dispose (a hash mismatch), not deleted.
    expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, changed: true, hash: sha('E\n') });
    expect(fs.existsSync(path.join(priv, p.displaced))).toBe(true);
  });

  test('deletion before the exchange: gone, never recreated, the staged entry removed', async () => {
    const r = await read();
    const pending = publish(r, { pause: 'beforeExchange', pauseMs: 2000 });
    await until(() => staged().length > 0);
    fs.unlinkSync(target());
    const p = await pending;
    expect(p).toMatchObject({ ok: false, conflict: 'gone' });
    expect(p.published).toBeUndefined();
    expect(fs.existsSync(target())).toBe(false);
    expect(staged()).toEqual([]);
  });

  test('the directory moved outside the root after the exchange: published, uncertain escaped, no rollback', async () => {
    const r = await read();
    const pending = publish(r, { pause: 'afterExchange', pauseMs: 2000 });
    await until(() => fs.readFileSync(target(), 'utf8') === 'two\n');
    fs.renameSync(path.join(root, 'docs'), path.join(dir, 'outside'));
    const p = await pending;
    expect(p).toMatchObject({ ok: false, published: true, uncertain: 'escaped' });
    expect(fs.readFileSync(path.join(dir, 'outside/a.md'), 'utf8')).toBe('two\n');
    expect(fs.readdirSync(path.join(dir, 'outside'))).toEqual(['a.md']);
    expect(fs.readFileSync(path.join(priv, p.displaced), 'utf8')).toBe('one\n');
  });

  test('the directory moved outside before the publish is refused before any change', async () => {
    const r = await read();
    const pending = publish(r, { pause: 'beforeOpen', pauseMs: 1500 });
    await sleep(300);
    fs.renameSync(path.join(root, 'docs'), path.join(dir, 'outside'));
    fs.symlinkSync(path.join(dir, 'outside'), path.join(root, 'docs'));
    const p = await pending;
    expect(p.ok).toBe(false);
    expect(p.published).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'outside/a.md'), 'utf8')).toBe('one\n');
  });

  test('fault afterExchange: published, uncertain observation, and synced', async () => {
    const r = await read();
    const p = await publish(r, { fault: 'afterExchange' });
    expect(p).toMatchObject({ ok: false, published: true, uncertain: 'observation', synced: true });
    expect(fs.readFileSync(target(), 'utf8')).toBe('two\n');
    expect(fs.readFileSync(path.join(priv, p.displaced), 'utf8')).toBe('one\n');
  });

  test('a failed directory sync is reported apart from identity (synced: false), and only a later flush confirms it (review round 2: durability)', async () => {
    const r = await read();
    const p = await publish(r, { fault: 'dirSync' });
    expect(p).toMatchObject({ ok: false, published: true, synced: false });
    expect(p.uncertain).toBeUndefined(); // What is installed is proven; only its durability is not.
    expect(fs.readFileSync(target(), 'utf8')).toBe('two\n');
    expect(fs.readFileSync(path.join(priv, p.displaced), 'utf8')).toBe('one\n');
    expect(await h.call({ op: 'flush', path: 'docs/a.md', fault: 'dirSync' })).toEqual({ ok: false, synced: false, id: expect.any(Number) });
    expect(await h.call({ op: 'flush', path: 'docs/a.md', fault: 'privSync' })).toEqual({ ok: false, synced: false, id: expect.any(Number) });
    expect(await h.call({ op: 'flush', path: 'docs/a.md' })).toMatchObject({ ok: true });
  });

  test('a publish refuses before any change when another account could move a directory on the path (security round 3: confinement)', async () => {
    const r = await read();
    fs.chmodSync(root, 0o777); // Anyone may rename docs/ out of the project.
    const p = await publish(r);
    expect(p.ok).toBe(false);
    expect(p.published).toBeUndefined();
    expect(p.error).toMatch(/others can write/);
    expect(fs.readFileSync(target(), 'utf8')).toBe('one\n');
    expect(staged()).toEqual([]);
    fs.chmodSync(root, 0o1777); // Sticky: only the owner of docs/ may rename it.
    expect(await publish(r)).toMatchObject({ ok: true, published: true });
  });

  test('a group-writable directory on the path is refused unless its group is our own private group (round 4: shared group)', async () => {
    const r = await read();
    fs.chmodSync(root, 0o770);
    // Our private group (no other member, no other account's primary group): our own.
    const privateGroup = await publish(r, { testGroupMembers: [] });
    if (privateGroup.ok !== true) expect(privateGroup.error).toMatch(/others can write/); // A host whose group is shared.
    // Another account in our primary group can rename docs/ out of the project (a COEDIT_FS_TEST-only member list).
    const shared = await publish(await h.call({ op: 'read', path: 'docs/a.md' }), { testGroupMembers: ['someone-else'] });
    expect(shared).toMatchObject({ ok: false });
    expect(shared.published).toBeUndefined();
    expect(shared.error).toMatch(/others can write/);
    // A real supplementary group we belong to is not ours alone.
    const other = process.getgroups().find((g) => g !== process.getegid());
    if (other !== undefined) {
      fs.chownSync(root, process.geteuid(), other);
      const p = await publish(await h.call({ op: 'read', path: 'docs/a.md' }));
      expect(p.error).toMatch(/others can write/);
      expect(p.published).toBeUndefined();
    }
  });

  test('a sticky directory on the path is refused when the child on the path is another account\'s (round 4: sticky)', async () => {
    const r = await read();
    fs.chmodSync(root, 0o1777);
    // docs/ owned by another account (a COEDIT_FS_TEST-only owner): that owner may rename it despite the sticky bit.
    const p = await publish(r, { testOwners: { docs: 4242 } });
    expect(p).toMatchObject({ ok: false });
    expect(p.published).toBeUndefined();
    expect(p.error).toMatch(/others can write/);
    expect(fs.readFileSync(target(), 'utf8')).toBe('one\n');
    expect(staged()).toEqual([]);
  });

  describe('smartyfs#34 follow-ups', () => {
    test('a directory on the path with an extended ACL is refused before any change (item 7: a named user could move it)', async () => {
      const r = await read();
      setAcl(root, 'system.posix_acl_access', extended(7));
      const p = await publish(r);
      expect(p).toMatchObject({ ok: false });
      expect(p.published).toBeUndefined();
      expect(p.error).toMatch(/ACL/);
      expect(fs.readFileSync(target(), 'utf8')).toBe('one\n');
      expect(staged()).toEqual([]);
    });

    test('set-user-ID and set-group-ID bits are not carried onto our file (item 11)', async () => {
      fs.chmodSync(target(), 0o6755);
      const r = await h.call({ op: 'read', path: 'docs/a.md' });
      expect(await publish(r)).toMatchObject({ ok: true });
      expect(fs.statSync(target()).mode & 0o7777).toBe(0o755);
    });

    test('the file keeps its group (item 13)', async () => {
      const other = process.getgroups().find((g) => g !== process.getegid());
      if (other === undefined) return; // A host where we are in one group only.
      fs.chownSync(target(), process.geteuid(), other);
      const r = await h.call({ op: 'read', path: 'docs/a.md' });
      expect(await publish(r)).toMatchObject({ ok: true });
      expect(fs.statSync(target()).gid).toBe(other);
    });

    test('the file keeps its access ACL (item 13)', async () => {
      setAcl(target(), 'system.posix_acl_access', extended(4));
      const before = getXattr(target(), 'system.posix_acl_access');
      const r = await h.call({ op: 'read', path: 'docs/a.md' });
      expect(await publish(r)).toMatchObject({ ok: true });
      expect(getXattr(target(), 'system.posix_acl_access')).toBe(before);
    });

    test('a default ACL on the private dir is removed at start, so our file gains no named entries (item 13)', async () => {
      const priv2 = path.join(dir, 'recovery2/.staging');
      fs.mkdirSync(priv2, { recursive: true });
      fs.chmodSync(priv2, 0o700);
      setAcl(priv2, 'system.posix_acl_default', [[ACL.USER_OBJ, 7, ANY], [ACL.USER, 7, 4242], [ACL.GROUP_OBJ, 0, ANY], [ACL.MASK, 7, ANY], [ACL.OTHER, 0, ANY]]);
      h.stop();
      h = helper(root, priv2);
      const r = await read();
      expect(await publish(r)).toMatchObject({ ok: true });
      expect(getXattr(priv2, 'system.posix_acl_default')).toBe('none');
      expect(getXattr(target(), 'system.posix_acl_access')).toBe('none');
    });

    test('a flush after an escaped publish flushes the directory it published into, not the path (item 2)', async () => {
      const r = await read();
      const pending = publish(r, { pause: 'afterExchange', pauseMs: 2000, fault: 'dirSync' });
      await until(() => fs.readFileSync(target(), 'utf8') === 'two\n');
      fs.renameSync(path.join(root, 'docs'), path.join(dir, 'outside'));
      fs.mkdirSync(path.join(root, 'docs')); // Another directory now at the path.
      const p = await pending;
      expect(p).toMatchObject({ published: true, synced: false });
      const f = await h.call({ op: 'flush', path: 'docs/a.md', entry: p.displaced });
      expect(f).toMatchObject({ ok: true, ino: fs.statSync(path.join(dir, 'outside')).ino });
    });
  });

  test('a plain publish is synced; a dispose whose private-dir sync fails says so (synced: false)', async () => {
    const r = await read();
    const p = await publish(r);
    expect(p).toMatchObject({ ok: true, published: true, synced: true });
    expect(await h.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: r.hash, fault: 'privSync' })).toMatchObject({ ok: true, synced: false });
    expect(staged()).toEqual([]);
  });

  test('dispose: busy while a writer is open, a late write is kept with its data', async () => {
    const r = await read();
    const writer = fs.openSync(target(), 'a');
    const p = await publish(r);
    expect(p.ok).toBe(true);
    fs.writeSync(writer, 'late\n');
    expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, busy: true });
    fs.closeSync(writer);
    const late = await dispose(p.displaced, r.hash);
    expect(late).toMatchObject({ ok: false, changed: true, hash: sha('one\nlate\n') });
    expect(Buffer.from(late.data, 'base64').toString()).toBe('one\nlate\n');
    expect(fs.existsSync(path.join(priv, p.displaced))).toBe(true);
    expect(await dispose(p.displaced, late.hash)).toMatchObject({ ok: true });
    expect(await dispose(p.displaced, late.hash)).toMatchObject({ ok: true }); // Already gone: ok.
  });

  test('dispose and list reach only the private dir; a project file named .x.coedit-foo is never touched', async () => {
    fs.writeFileSync(path.join(root, 'docs/.a.md.coedit-foo'), 'mine\n');
    fs.writeFileSync(path.join(dir, 'recovery/outside'), 'out\n');
    const r = await read();
    const p = await publish(r);
    expect(p.ok).toBe(true);
    for (const entry of ['.a.md.coedit-foo', `../../project/docs/.a.md.coedit-foo`, `${KEY}./../../outside`, '..', 'a.md', `${KEY}/x`])
      expect([entry, (await dispose(entry, sha('mine\n'))).ok]).toEqual([entry, false]);
    expect((await h.call({ op: 'dispose', path: '../x', entry: '../x.1', hash: 'x' })).ok).toBe(false);
    expect((await h.call({ op: 'list', path: '..' })).ok).toBe(false);
    expect((await h.call({ op: 'list', key: KEY })).ok).toBe(false); // A caller's key is never taken: a path is needed.
    expect(fs.readFileSync(path.join(root, 'docs/.a.md.coedit-foo'), 'utf8')).toBe('mine\n');
    expect(fs.readFileSync(path.join(dir, 'recovery/outside'), 'utf8')).toBe('out\n');
    expect(docs()).toEqual(['.a.md.coedit-foo', 'a.md']);
    expect((await h.call({ op: 'list', path: 'docs/a.md' })).entries.map((e) => e.entry)).toEqual([p.displaced]);
  });

  test('a FIFO at the target: read and publish return an error promptly', async () => {
    const r = await read();
    fs.unlinkSync(target());
    expect(spawnSync('mkfifo', [target()]).status).toBe(0);
    const started = Date.now();
    const timeout = sleep(3000).then(() => ({ hung: true }));
    const rd = await Promise.race([h.call({ op: 'read', path: 'docs/a.md' }), timeout]);
    expect(rd).toMatchObject({ ok: false });
    expect(rd.error).toBeTruthy();
    const pb = await Promise.race([publish(r), timeout]);
    expect(pb).toMatchObject({ ok: false });
    expect(pb.published).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(staged()).toEqual([]);
  });

  test('a stale check (other bytes, same inode) is a conflict before any write', async () => {
    const r = await read();
    fs.writeFileSync(target(), 'edited in place\n');
    expect(await publish(r)).toMatchObject({ ok: false, conflict: 'changed' });
    expect(staged()).toEqual([]);
    expect(docs()).toEqual(['a.md']);
  });

  test('the protocol refuses unknown ops, escaping or linked paths and bad input', async () => {
    fs.writeFileSync(path.join(dir, 'secret'), 'secret\n');
    fs.symlinkSync(path.join(dir, 'secret'), path.join(root, 'link'));
    expect(await h.call({ op: 'unlink', path: 'docs/a.md' })).toMatchObject({ ok: false, error: 'unknown op' });
    for (const p of ['../secret', '/etc/passwd', 'link', 'docs/../../secret', '', 'docs/..'])
      expect([p, (await h.call({ op: 'read', path: p })).ok]).toEqual([p, false]);
    expect(await h.raw('{not json')).toMatchObject({ ok: false, error: 'invalid json' });
    expect(fs.readFileSync(target(), 'utf8')).toBe('one\n');
    expect(staged()).toEqual([]);
    // A caller's key is ignored (#412 finding 1): the entry is named by the key the helper computes itself.
    const p = await publish(await read(), { key: 'ZZ/..' });
    expect(p.displaced.startsWith(`${KEY}.`)).toBe(true);
    expect(staged()).toEqual([p.displaced]);
  });

  test('the helper exits 2 on a private dir with group/other bits, or none given', () => {
    const loose = path.join(dir, 'loose');
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o750);
    expect(spawnSync(BIN, ['--same-account', root, loose], { input: '' }).status).toBe(2);
    expect(spawnSync(BIN, ['--same-account', root], { input: '' }).status).toBe(2);
    expect(spawnSync(BIN, ['--same-account', root, path.join(dir, 'missing')], { input: '' }).status).toBe(2);
    fs.symlinkSync(priv, path.join(dir, 'privlink'));
    expect(spawnSync(BIN, ['--same-account', root, path.join(dir, 'privlink')], { input: '' }).status).toBe(2);
  });

  describe('its own account (smartyfs#32: the helper never serves the account it runs as)', () => {
    const hello = `${JSON.stringify({ op: 'hello', id: 1 })}\n`;
    test('started as the account it serves (the peer on its stdin socket is its own uid) it refuses, exit 2', () => {
      // Node's stdio pipes are socketpairs, so the helper sees this test's uid (its own) as its peer.
      const direct = spawnSync(BIN, [root, priv], { input: hello, encoding: 'utf8' });
      expect(direct.status).toBe(2);
      expect(direct.stderr).toMatch(/own account/);
      const service = spawnSync(BIN, ['--socket', priv], { input: hello, encoding: 'utf8' });
      expect(service.status).toBe(2);
      expect(service.stderr).toMatch(/own account/);
    });

    test('socket mode takes its root from hello, then works as before (with --same-account, tests only)', async () => {
      const child = spawn(BIN, ['--socket', priv, '--same-account'], { stdio: ['pipe', 'pipe', 'inherit'] });
      const lines = createInterface({ input: child.stdout });
      const replies = [];
      lines.on('line', (l) => replies.push(JSON.parse(l)));
      child.stdin.write(`${JSON.stringify({ op: 'read', path: 'docs/a.md', id: 1 })}\n`);
      child.stdin.write(`${JSON.stringify({ op: 'hello', root, id: 2 })}\n`);
      child.stdin.write(`${JSON.stringify({ op: 'read', path: 'docs/a.md', id: 3 })}\n`);
      await until(() => replies.length === 3);
      child.kill();
      expect(replies[0]).toMatchObject({ ok: false, error: expect.stringMatching(/hello/) }); // No root yet.
      expect(replies[1]).toMatchObject({ ok: true, protocol: 3 });
      expect(Buffer.from(replies[2].data, 'base64').toString()).toBe('one\n');
    });

    test('#412 finding 1: a root that is the private dir, inside it, or an ancestor of it is refused; nothing before hello', async () => {
      const probe = async (rootArg) => {
        const child = spawn(BIN, ['--socket', priv, '--same-account'], { stdio: ['pipe', 'pipe', 'inherit'] });
        const replies = [];
        createInterface({ input: child.stdout }).on('line', (l) => replies.push(JSON.parse(l)));
        child.stdin.write(`${JSON.stringify({ op: 'list', path: 'x.md', id: 1 })}\n`);
        child.stdin.write(`${JSON.stringify({ op: 'hello', root: rootArg, id: 2 })}\n`);
        await until(() => replies.length === 2);
        child.kill();
        return replies;
      };
      for (const bad of [priv, path.join(dir, 'recovery'), dir, '/']) {
        const [list, hello] = await probe(bad);
        expect(list).toMatchObject({ ok: false, error: expect.stringMatching(/hello/) });
        expect([bad, hello.ok]).toEqual([bad, false]);
      }
      fs.mkdirSync(path.join(priv, 'inner'));
      expect((await probe(path.join(priv, 'inner')))[1].ok).toBe(false);
      expect((await probe(root))[1]).toMatchObject({ ok: true, protocol: 3 });
    });

    test('#412 findings 1 and 3: a second connection cannot touch a file\'s entries while a save is in flight; its list waits for it', async () => {
      const r = await read();
      const second = helper(root, priv);
      try {
        const saving = publish(r, { pause: 'beforeExchange', pauseMs: 1500 });
        await until(() => staged().some((n) => n.endsWith('.staged')));
        const order = [];
        const listing = second.call({ op: 'list', path: 'docs/a.md' }).then((l) => { order.push('list'); return l; });
        const p = await saving.then((x) => { order.push('publish'); return x; });
        const l = await listing;
        expect(order).toEqual(['publish', 'list']); // The list waited for the save's lock.
        expect(p).toMatchObject({ ok: true, published: true });
        expect(l.entries.map((e) => e.entry)).toEqual([p.displaced]); // It sees the finished transaction only.
        expect(fs.readFileSync(target(), 'utf8')).toBe('two\n');
      } finally {
        second.stop();
      }
    });

    test('#412 finding 3: a save whose connection has closed by the time it runs publishes nothing', async () => {
      const r = await read();
      const child = spawn(BIN, ['--same-account', root, priv], { env: { ...process.env, COEDIT_FS_TEST: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
      const blocker = helper(root, priv);
      try {
        // Another connection holds the file's lock, so the doomed save waits for it; its connection closes meanwhile.
        const holding = blocker.call({ op: 'publish', path: 'docs/a.md', ino: r.ino, dev: r.dev, hash: r.hash, data: Buffer.from('held\n').toString('base64'), pause: 'beforeOpen', pauseMs: 800 });
        await sleep(150);
        child.stdin.end(`${JSON.stringify({ op: 'publish', path: 'docs/a.md', ino: r.ino, dev: r.dev, hash: r.hash, data: Buffer.from('late\n').toString('base64'), id: 1 })}\n`);
        await holding;
        await new Promise((done) => child.on('exit', done));
        expect(fs.readFileSync(target(), 'utf8')).toBe('held\n'); // Never 'late'.
      } finally {
        blocker.stop();
        child.kill();
      }
    });

    test('#412 round 2, finding 1: another live connection can neither read nor dispose this connection\'s pending revision; a late write is kept', async () => {
      const r = await read();
      const writer = fs.openSync(target(), 'a'); // An agent holding the old inode open: the revision stays pending.
      const p = await publish(r);
      expect(p).toMatchObject({ ok: true });
      expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, busy: true });
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      const other = helper(root, priv);
      try {
        const seen = await other.call({ op: 'list', path: 'docs/a.md' });
        expect(seen.entries).toEqual([{ entry: p.displaced, owned: true }]); // Named, but no bytes to take over.
        const hash = sha('one\nlate\n');
        expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash })).toMatchObject({ ok: false, owned: true });
        expect(staged()).toEqual([p.displaced]);
        // Its owner still finds the late bytes and keeps them.
        expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, changed: true, hash });
      } finally {
        other.stop();
      }
    });

    test('#412 round 2, finding 1: once its owner is gone, the entry is an orphan another connection recovers with its bytes', async () => {
      const r = await read();
      const writer = fs.openSync(target(), 'a');
      const p = await publish(r);
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      h.stop(); // The owning connection ends (its bridge closed or crashed).
      await sleep(200);
      h = helper(root, priv);
      const seen = await h.call({ op: 'list', path: 'docs/a.md' });
      expect(seen.entries).toMatchObject([{ entry: p.displaced, hash: sha('one\nlate\n') }]);
      expect(Buffer.from(seen.entries[0].data, 'base64').toString()).toBe('one\nlate\n');
    });

    test('#412 round 3, finding 1: a writer\'s own flock on the file cannot take the transaction\'s ownership', async () => {
      // A writer that opens the project file for appending and holds an exclusive advisory flock on it.
      const writer = spawn('python3', ['-c', "import fcntl,sys\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('ready',flush=True)\nsys.stdin.readline()\nf.write('late\\n');f.flush()\nfcntl.flock(f,fcntl.LOCK_UN)\nf.close()", target()], { stdio: ['pipe', 'pipe', 'inherit'] });
      await new Promise((done) => createInterface({ input: writer.stdout }).once('line', done));
      const r = await read();
      const p = await publish(r);
      expect(p).toMatchObject({ ok: true });
      expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, busy: true });
      writer.stdin.end('go\n'); // It appends through its old descriptor, unlocks and closes.
      await new Promise((done) => writer.on('exit', done));
      const other = helper(root, priv);
      try {
        const seen = await other.call({ op: 'list', path: 'docs/a.md' });
        expect(seen.entries).toEqual([{ entry: p.displaced, owned: true }]);
        expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: sha('one\nlate\n') })).toMatchObject({ ok: false, owned: true });
        expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, changed: true, hash: sha('one\nlate\n') });
      } finally {
        other.stop();
      }
    });

    test('#412 round 3, finding 2: orphan recovery keeps the transaction record, so the lost reply is still decided', async () => {
      const r = await read();
      const pending = publish(r, { txn: 'abc123', ack: sha('secret'), pause: 'afterExchange', pauseMs: 5000 });
      await until(() => fs.readFileSync(target(), 'utf8') === 'two\n');
      h.stop(); // The reply is lost: the helper dies right after the exchange (its call never answers).
      void pending;
      await sleep(200);
      const recoverer = helper(root, priv); // Another bridge's load: recovers the orphan entry.
      try {
        const seen = await recoverer.call({ op: 'list', path: 'docs/a.md', tokens: { abc123: 'secret' } });
        expect(seen.records).toEqual([{ txn: 'abc123', state: 'published' }]);
        const [entry] = seen.entries;
        expect(Buffer.from(entry.data, 'base64').toString()).toBe('one\n');
        expect(await recoverer.call({ op: 'dispose', path: 'docs/a.md', entry: entry.entry, hash: entry.hash, token: 'secret' })).toMatchObject({ ok: true });
      } finally {
        recoverer.stop();
      }
      h = helper(root, priv); // The originating bridge reconnects.
      const later = await h.call({ op: 'list', path: 'docs/a.md', tokens: { abc123: 'secret' } });
      expect(later.entries).toEqual([]);
      expect(later.records).toEqual([{ txn: 'abc123', state: 'published' }]); // Still decided: never "not published".
      expect(await h.call({ op: 'ack', path: 'docs/a.md', txn: 'abc123', token: 'secret' })).toMatchObject({ ok: true });
      expect((await h.call({ op: 'list', path: 'docs/a.md', tokens: { abc123: 'secret' } })).records).toEqual([]);
    });

    /** A publish whose reply is lost right after the exchange (its helper dies before it records "published"). */
    const lostAfterExchange = async (txn, token) => {
      const r = await read();
      void publish(r, { txn, ack: sha(token), pause: 'afterExchange', pauseMs: 5000 });
      await until(() => fs.readFileSync(target(), 'utf8') === 'two\n');
      h.stop();
      await sleep(200);
      h = helper(root, priv);
    };

    test('#412 round 4, finding 1: only the originating bridge\'s secret token acknowledges a record; its txn grants nothing', async () => {
      await lostAfterExchange('abc124', 'origin-secret');
      const tokens = { abc124: 'origin-secret' };
      const seen = await h.call({ op: 'list', path: 'docs/a.md', tokens });
      expect(seen.records).toEqual([{ txn: 'abc124', state: 'published' }]); // No hash or token is ever listed.
      const [entry] = seen.entries;
      expect(await h.call({ op: 'dispose', path: 'docs/a.md', entry: entry.entry, hash: entry.hash, token: 'origin-secret' })).toMatchObject({ ok: true });
      for (const token of [undefined, '', 'guess', sha('origin-secret')]) {
        expect(await h.call({ op: 'ack', path: 'docs/a.md', txn: 'abc124', token })).toMatchObject({ ok: false });
      }
      expect((await h.call({ op: 'list', path: 'docs/a.md', tokens })).records).toEqual([{ txn: 'abc124', state: 'published' }]);
      expect(await h.call({ op: 'ack', path: 'docs/a.md', txn: 'abc124', token: 'origin-secret' })).toMatchObject({ ok: true });
      expect((await h.call({ op: 'list', path: 'docs/a.md', tokens })).records).toEqual([]);
    });

    test('#412 round 4, finding 2: a failed scan or record write leaves the outcome unknown and the evidence in place', async () => {
      await lostAfterExchange('abc125', 's');
      const tokens = { abc125: 's' };
      const scanFailed = await h.call({ op: 'list', path: 'docs/a.md', tokens, fault: 'stagedScan' });
      expect(scanFailed.records).toEqual([{ txn: 'abc125', state: 'unknown' }]); // Never guessed as "aborted".
      const [entry] = scanFailed.entries;
      const writeFailed = await h.call({ op: 'dispose', path: 'docs/a.md', entry: entry.entry, hash: entry.hash, token: 's', fault: 'recordWrite' });
      expect(writeFailed.ok).toBe(false); // No terminal outcome persisted: the entry it would be derived from stays.
      expect(staged()).toEqual([entry.entry]);
      expect((await h.call({ op: 'list', path: 'docs/a.md', tokens })).records).toEqual([{ txn: 'abc125', state: 'published' }]);
    });

    test('#412 round 5 (security): after its helper is lost, a live bridge\'s pending revision stays its own; only its token reclaims it', async () => {
      const writer = fs.openSync(target(), 'a');
      const r = await read();
      const p = await publish(r, { txn: 'bbb111', ack: sha('mine') });
      expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, busy: true });
      h.stop(); // Only the helper connection is lost; the bridge (holding the token) lives on.
      await sleep(200);
      h = helper(root, priv); // The bridge reconnects.
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      const other = helper(root, priv); // An unrelated process of the served account.
      try {
        const seen = await other.call({ op: 'list', path: 'docs/a.md' });
        expect(seen.entries).toEqual([{ entry: p.displaced, owned: true }]); // No bytes to take.
        expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: sha('one\nlate\n') })).toMatchObject({ ok: false, owned: true });
        expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: sha('one\nlate\n'), token: 'guess' })).toMatchObject({ ok: false, owned: true });
        // Settling with an ack while its data is pending keeps the record guarding that data.
        expect(await h.call({ op: 'ack', path: 'docs/a.md', txn: 'bbb111', token: 'mine' })).toMatchObject({ ok: true, pending: true });
        expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: sha('one\nlate\n') })).toMatchObject({ ok: false, owned: true });
      } finally {
        other.stop();
      }
      // The reconnected bridge reclaims it with its token, and keeps the late bytes.
      expect(await h.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: r.hash, token: 'mine' })).toMatchObject({ ok: false, changed: true, hash: sha('one\nlate\n') });
    });

    test('#412 round 5 (astra 1): records are immutable; a recoverer killed while creating the outcome leaves it recoverable', async () => {
      await lostAfterExchange('ccc111', 't');
      const recordPath = path.join(priv, `${KEY}.ccc111.txn`);
      const before = { ino: fs.statSync(recordPath).ino, bytes: fs.readFileSync(recordPath, 'utf8') };
      // A recoverer dies right before linking the outcome it wrote.
      const dying = helper(root, priv);
      void dying.call({ op: 'list', path: 'docs/a.md', tokens: { ccc111: 't' }, pause: 'beforeRecordLink', pauseMs: 5000 });
      await sleep(400);
      dying.stop();
      await sleep(200);
      const seen = await h.call({ op: 'list', path: 'docs/a.md', tokens: { ccc111: 't' } });
      expect(seen.records).toEqual([{ txn: 'ccc111', state: 'published' }]);
      expect({ ino: fs.statSync(recordPath).ino, bytes: fs.readFileSync(recordPath, 'utf8') }).toEqual(before); // Never rewritten.
    });

    test('#412 round 5 (astra 2): an outcome is trusted only once a flush succeeds: a failed flush fails every retry until one works', async () => {
      await lostAfterExchange('ddd111', 'u');
      const tokens = { ddd111: 'u' };
      const [entry] = (await h.call({ op: 'list', path: 'docs/a.md', tokens })).entries;
      for (let i = 0; i < 2; i += 1) {
        const failed = await h.call({ op: 'dispose', path: 'docs/a.md', entry: entry.entry, hash: entry.hash, token: 'u', fault: 'recordSync' });
        expect(failed.ok).toBe(false);
        expect(staged()).toEqual([entry.entry]); // The evidence stays.
      }
      expect(await h.call({ op: 'dispose', path: 'docs/a.md', entry: entry.entry, hash: entry.hash, token: 'u' })).toMatchObject({ ok: true });
    });

    test('#412 round 4 (astra 1): a txn reused on another file grants nothing over this file\'s transaction', async () => {
      const writer = fs.openSync(target(), 'a'); // Keeps A's displaced revision pending.
      const r = await read();
      const p = await publish(r, { txn: 'aaa111', ack: sha('a') });
      expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, busy: true });
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      fs.writeFileSync(path.join(root, 'docs/b.md'), 'bee\n');
      const b = helper(root, priv);
      try {
        // B learns A's txn from list, then owns the SAME txn on another file.
        expect((await b.call({ op: 'list', path: 'docs/a.md' })).records).toEqual([{ txn: 'aaa111', owned: true }]);
        const rb = await b.call({ op: 'read', path: 'docs/b.md' });
        expect(await b.call({ op: 'publish', path: 'docs/b.md', txn: 'aaa111', ack: sha('b'), ino: rb.ino, dev: rb.dev, hash: rb.hash, data: Buffer.from('BEE\n').toString('base64') })).toMatchObject({ published: true });
        const seen = await b.call({ op: 'list', path: 'docs/a.md' });
        expect(seen.entries).toEqual([{ entry: p.displaced, owned: true }]); // Still no bytes.
        expect(await b.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: sha('one\nlate\n') })).toMatchObject({ ok: false, owned: true });
        // A fabricated missing entry with A's key and the reused txn cannot retire A's record either.
        expect(await b.call({ op: 'dispose', path: 'docs/a.md', entry: `${KEY}.aaa111-bogus.staged`, hash: 'x' })).toMatchObject({ ok: false, owned: true });
        expect((await b.call({ op: 'list', path: 'docs/a.md' })).records).toEqual([{ txn: 'aaa111', owned: true }]);
      } finally {
        b.stop();
      }
      // A still owns it, and keeps the late bytes.
      expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, changed: true, hash: sha('one\nlate\n') });
      // A's own dispose of a name its publish did not produce is refused.
      expect(await dispose(`${KEY}.aaa111-bogus.staged`, r.hash)).toMatchObject({ ok: false });
    });

    test('#412 round 6: a publish reusing a live transaction\'s id on the same file never touches its record', async () => {
      const writer = fs.openSync(target(), 'a');
      const r = await read();
      const p = await publish(r, { txn: 'eee111', ack: sha('a-token') });
      expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, busy: true });
      const recordPath = path.join(priv, `${KEY}.eee111.txn`);
      const before = { ino: fs.statSync(recordPath).ino, bytes: fs.readFileSync(recordPath, 'utf8') };
      const other = helper(root, priv);
      try {
        const current = await other.call({ op: 'read', path: 'docs/a.md' });
        for (const fault of [undefined, 'recordCreate']) {
          const reply = await other.call({ op: 'publish', path: 'docs/a.md', txn: 'eee111', ack: sha('b'), ino: current.ino, dev: current.dev, hash: current.hash, data: Buffer.from('B\n').toString('base64'), fault });
          expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/already in use/) });
          expect({ ino: fs.statSync(recordPath).ino, bytes: fs.readFileSync(recordPath, 'utf8') }).toEqual(before);
        }
        expect((await other.call({ op: 'list', path: 'docs/a.md' })).entries).toEqual([{ entry: p.displaced, owned: true }]);
        fs.writeSync(writer, 'late\n');
        fs.closeSync(writer);
        expect(await other.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: sha('two\nlate\n') })).toMatchObject({ ok: false, owned: true });
      } finally {
        other.stop();
      }
      expect(fs.readFileSync(target(), 'utf8')).toBe('two\n'); // B published nothing.
      expect(await dispose(p.displaced, r.hash)).toMatchObject({ ok: false, changed: true, hash: sha('one\nlate\n') });
    });

    test('#412 round 6: a record that fails before its own link leaves no name behind and removes none', async () => {
      const r = await read();
      const reply = await publish(r, { txn: 'fff111', ack: sha('x'), fault: 'recordCreate' });
      expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be established/) });
      expect(fs.readdirSync(priv).filter((n) => !n.endsWith('-lock'))).toEqual([]);
      expect(fs.readFileSync(target(), 'utf8')).toBe('one\n');
    });

    /** The bridge's recovery directory beside the private dir, 0700, admitted by hello. */
    const recoveryDir = () => {
      fs.chmodSync(path.join(dir, 'recovery'), 0o700);
      return path.join(dir, 'recovery');
    };
    /** An origin process that names `recovery` in its hello, publishes with `txn`, and exits. */
    const publishFromExitingOrigin = async (txn, recovery) => {
      const r = await read();
      const origin = spawn(process.execPath, ['-e', `
        const { spawn } = require('child_process');
        const h = spawn(process.argv[1], ['--same-account', process.argv[2], process.argv[3]], { stdio: ['pipe', 'pipe', 'inherit'] });
        let n = 0;
        require('readline').createInterface({ input: h.stdout }).on('line', (l) => { if (++n === 2) { console.log(l); process.exit(0); } });
        h.stdin.write(process.argv[4] + '\\n');
        h.stdin.write(process.argv[5] + '\\n');
      `, BIN, root, priv, JSON.stringify({ op: 'hello', recovery, id: 1 }), JSON.stringify({ op: 'publish', path: 'docs/a.md', txn, ack: sha('lost-with-its-process'), ino: r.ino, dev: r.dev, hash: r.hash, data: Buffer.from('two\n').toString('base64'), id: 2 })], { stdio: ['ignore', 'pipe', 'inherit'] });
      const reply = await new Promise((done) => createInterface({ input: origin.stdout }).once('line', (l) => done(JSON.parse(l))));
      await new Promise((done) => (origin.exitCode === null ? origin.on('exit', done) : done()));
      await sleep(300); // Its helper reads EOF and exits, releasing the record's lock.
      return reply;
    };

    test('smartyfs#32 pre-enable: once its originating process is gone, a transaction is a true orphan, recovered at once', async () => {
      const writer = fs.openSync(target(), 'a'); // Keeps the displaced revision pending after the publish.
      const reply = await publishFromExitingOrigin('a0a0a0', recoveryDir());
      expect(reply).toMatchObject({ published: true });
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      // No token: the caller gains nothing, but its origin is gone, so the HELPER itself delivers the final bytes into
      // the origin's recovery directory now (not after 7 days); the caller learns only where (#428 rounds 1 and 2).
      const seen = await h.call({ op: 'list', path: 'docs/a.md' });
      expect(seen.records).toEqual([{ txn: 'a0a0a0', state: 'published', owned: true, orphan: false }]);
      expect(seen.entries).toEqual([]); // The displaced entry is gone only after its bytes were delivered.
      expect(seen.recovered).toEqual([{ marker: expect.stringMatching(/\.done$/), path: expect.stringContaining(`-${KEY}-reca0a0a0`), hash: sha('one\nlate\n') }]);
      expect(JSON.stringify(seen)).not.toContain(Buffer.from('one\nlate\n').toString('base64')); // No bytes to the caller.
      expect(fs.readFileSync(seen.recovered[0].path, 'utf8')).toBe('one\nlate\n');
      expect((await h.call({ op: 'list', path: 'docs/a.md' })).recovered).toHaveLength(1); // Delivered once.
    });

    test('#428 round 2: an orphan is delivered only to the recovery directory its ORIGIN bound, whatever a later caller names', async () => {
      const writer = fs.openSync(target(), 'a');
      const reply = await publishFromExitingOrigin('b0b0b0', recoveryDir());
      expect(reply).toMatchObject({ published: true });
      fs.writeSync(writer, 'late\n');
      fs.closeSync(writer);
      // An unrelated caller names its OWN private recovery directory, then lists.
      const theirs = path.join(dir, 'theirs');
      fs.mkdirSync(theirs, { mode: 0o700 });
      const other = helper(root, priv);
      try {
        expect(await other.call({ op: 'hello', recovery: theirs })).toMatchObject({ ok: true });
        const seen = await other.call({ op: 'list', path: 'docs/a.md' });
        expect(fs.readdirSync(theirs)).toEqual([]); // Nothing delivered to the caller's directory.
        expect(seen.recovered).toEqual([{ marker: expect.any(String), path: expect.stringContaining(recoveryDir()), hash: sha('one\nlate\n') }]);
        const copy = seen.recovered[0].path;
        expect(fs.readFileSync(copy, 'utf8')).toBe('one\nlate\n');
        expect(fs.statSync(copy).mode & 0o007).toBe(0); // No access for others.
        const acl = getXattr(copy, 'system.posix_acl_access');
        const uid = Buffer.alloc(4);
        uid.writeUInt32LE(process.geteuid());
        expect(acl).toContain(`02000600${uid.toString('hex')}`); // Exactly: user:<served>:rw-.
      } finally {
        other.stop();
      }
    });

    test('#428 round 2: a recovery directory others can read or search is refused', async () => {
      for (const mode of [0o705, 0o701, 0o750]) {
        const d = fs.mkdtempSync(path.join(dir, 'open-'));
        fs.chmodSync(d, mode);
        expect([mode.toString(8), (await h.call({ op: 'hello', recovery: d })).ok]).toEqual([mode.toString(8), false]);
      }
      const acl = fs.mkdtempSync(path.join(dir, 'acl-'));
      fs.chmodSync(acl, 0o700);
      setAcl(acl, 'system.posix_acl_access', [[ACL.USER_OBJ, 7, ANY], [ACL.USER, 5, 4242], [ACL.GROUP_OBJ, 0, ANY], [ACL.MASK, 7, ANY], [ACL.OTHER, 0, ANY]]);
      expect((await h.call({ op: 'hello', recovery: acl })).ok).toBe(false); // A read/search grant to another account.
    });

    /** A pending transaction whose connection has ended, with a chosen origin [pid, start] (a COEDIT_FS_TEST hook). */
    const orphanWithOrigin = async (txn, origin) => {
      replace('one\n'); // A fresh revision to publish over.
      const writer = fs.openSync(target(), 'a');
      await h.call({ op: 'hello', recovery: recoveryDir() }); // The origin binds its recovery directory.
      const r = await read();
      const p = await publish(r, { txn, ack: sha('t'), testOrigin: origin });
      await h.stop(); // Its helper connection ends; the origin decides who may recover it.
      h = helper(root, priv);
      await h.call({ op: 'hello', recovery: recoveryDir() });
      fs.closeSync(writer);
      return p;
    };
    const startOf = (pid) => Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').pop().trim().split(/\s+/)[19]);

    describe('smartyfs#46 defensive metadata', () => {
      const TXN = '46abcd';
      const gone = () => [process.pid, startOf(process.pid) + 1]; // Proven pid reuse, not a guessed unused pid.
      const recordPath = () => path.join(priv, `${KEY}.${TXN}.txn`);
      const outcomePath = () => path.join(priv, `${KEY}.${TXN}.out`);
      const missing = (field) => (record) => { const copy = { ...record }; delete copy[field]; return copy; };
      const set = (field, value) => (record) => ({ ...record, [field]: value });
      const destSet = (field, value) => (record) => ({ ...record, dest: { ...record.dest, [field]: value } });
      const fields = ['ino', 'ack', 'pid', 'start', 'dest'];
      const required = fields.map((field) => [`missing ${field}`, missing(field)]);
      const invalidTxn = [
        ...required,
        ['unknown field', set('unexpected', true)],
        ['invalid JSON', () => '{'],
        ...[null, [], true, 1, 'record'].map((value) => [`root ${JSON.stringify(value)}`, () => value]),
        ...['ino', 'pid', 'start'].flatMap((field) => [null, '1', true, -1, 1.5, 18446744073709551616].map((value) => [`${field} ${JSON.stringify(value)}`, set(field, value)])),
        ['ino zero', set('ino', 0)],
        ['unknown pid with nonzero start', (record) => ({ ...record, pid: 0, start: 1 })],
        ['pid exceeds i32', set('pid', 2147483648)],
        ['pid wraps to a live pid', (record) => ({ ...record, pid: 4294967296 + process.pid })],
        ...[null, 1, [], 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(65)].map((value) => [`ack ${JSON.stringify(value)}`, set('ack', value)]),
        ...[[], true, 1, 'directory'].map((value) => [`dest ${JSON.stringify(value)}`, set('dest', value)]),
        ...['path', 'dev', 'ino'].map((field) => [`missing dest.${field}`, (record) => ({ ...record, dest: missing(field)(record.dest) })]),
        ['unknown dest field', destSet('unexpected', true)],
        ['dest.ino zero', destSet('ino', 0)],
        ...[null, 1, [], '', 'relative', '/tmp/\0invalid'].map((value) => [`dest.path ${JSON.stringify(value)}`, destSet('path', value)]),
        ...['dev', 'ino'].flatMap((field) => [null, '1', true, -1, 1.5, 18446744073709551616].map((value) => [`dest.${field} ${JSON.stringify(value)}`, destSet(field, value)])),
      ];
      const writeRecord = (file, record) => fs.writeFileSync(file, record === '{' ? record : JSON.stringify(record));
      const snapshotFiles = (directory, names) => names.sort().map((name) => {
        const file = path.join(directory, name);
        const stat = fs.statSync(file);
        return { name, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, bytes: fs.readFileSync(file).toString('base64') };
      });
      const evidence = () => ({
        private: snapshotFiles(priv, fs.readdirSync(priv).filter((name) => !name.endsWith('-lock'))),
        delivered: snapshotFiles(recoveryDir(), fs.readdirSync(recoveryDir()).filter((name) => name !== '.staging')),
        project: snapshotFiles(path.join(root, 'docs'), docs()),
      });
      const refused = (reply, before, name) => {
        // Check preservation even when the helper wrongly returns success; diagnostics must name the bad evidence.
        expect.soft(evidence()).toEqual(before);
        expect(reply).toMatchObject({ ok: false, error: expect.stringContaining(name) });
      };

      /** Published records use the existing writer fixture; aborted records are killed before their exchange. */
      const retained = async (state) => {
        if (state === 'published') {
          const reply = await orphanWithOrigin(TXN, gone());
          expect(reply).toMatchObject({ ok: true, published: true });
          expect(fs.readFileSync(outcomePath(), 'utf8')).toBe('published');
          return reply.displaced;
        }
        expect(await h.call({ op: 'hello', recovery: recoveryDir() })).toMatchObject({ ok: true });
        const r = await read();
        void publish(r, { txn: TXN, ack: sha('t'), testOrigin: gone(), pause: 'beforeExchange', pauseMs: 5000 });
        await until(() => staged().length === 1);
        await h.stop();
        h = helper(root, priv);
        const [entry] = staged();
        expect(fs.readFileSync(target(), 'utf8')).toBe('one\n');
        expect(fs.readFileSync(path.join(priv, entry), 'utf8')).toBe('two\n');
        expect(JSON.parse(fs.readFileSync(recordPath(), 'utf8')).ino).toBe(fs.statSync(path.join(priv, entry)).ino);
        expect(fs.existsSync(outcomePath())).toBe(false);
        return entry;
      };

      describe.each(['aborted', 'published'])('%s transaction', (state) => {
        test.each(invalidTxn)('list refuses %s and retains all evidence', async (_label, mutate) => {
          await retained(state);
          writeRecord(recordPath(), mutate(JSON.parse(fs.readFileSync(recordPath(), 'utf8'))));
          const before = evidence();
          refused(await h.call({ op: 'list', path: 'docs/a.md' }), before, `${KEY}.${TXN}.txn`);
        });

        // Matching tokens and an already-published outcome must not bypass validation. Without a token,
        // dispose must validate before the helper recovers an orphan or treats a missing ack as the empty mode.
        test.each([
          ['token list', { op: 'list', tokens: { [TXN]: 't' } }],
          ['token dispose', { op: 'dispose', token: 't' }],
          ['tokenless dispose', { op: 'dispose' }],
          ['pending ack', { op: 'ack', txn: TXN, token: 't' }],
        ].flatMap(([label, request]) => [...required, ['unknown field', set('unexpected', true)]].map(([field, mutate]) => [`${label}: ${field}`, request, mutate])))('%s refuses and retains evidence', async (_label, request, mutate) => {
          const entry = await retained(state);
          writeRecord(recordPath(), mutate(JSON.parse(fs.readFileSync(recordPath(), 'utf8'))));
          const before = evidence();
          const reply = await h.call({ path: 'docs/a.md', entry, hash: sha(fs.readFileSync(path.join(priv, entry))), ...request });
          refused(reply, before, `${KEY}.${TXN}.txn`);
        });

        test.each([...required, ['unknown field', set('unexpected', true)]])('receipt ack refuses %s after valid disposal', async (_label, mutate) => {
          const entry = await retained(state);
          const bytes = fs.readFileSync(path.join(priv, entry));
          expect(await h.call({ op: 'dispose', path: 'docs/a.md', entry, hash: sha(bytes), token: 't' })).toMatchObject({ ok: true });
          expect(fs.existsSync(path.join(priv, entry))).toBe(false);
          writeRecord(recordPath(), mutate(JSON.parse(fs.readFileSync(recordPath(), 'utf8'))));
          const before = evidence();
          refused(await h.call({ op: 'ack', path: 'docs/a.md', txn: TXN, token: 't' }), before, `${KEY}.${TXN}.txn`);
        });
      });

      /** Get the exact current .done writer output, keeping the same staged inode for an interrupted-unlink retry. */
      const delivered = async (retry) => {
        const entry = await retained('published');
        const saved = path.join(dir, 'retained-for-retry');
        fs.linkSync(path.join(priv, entry), saved);
        const seen = await h.call({ op: 'list', path: 'docs/a.md' });
        expect(seen).toMatchObject({ ok: true, entries: [], recovered: [{ hash: sha('one\n') }] });
        const [{ marker, path: copy }] = seen.recovered;
        expect(fs.readFileSync(copy, 'utf8')).toBe('one\n');
        expect(fs.existsSync(path.join(priv, entry))).toBe(false);
        if (retry) fs.linkSync(saved, path.join(priv, entry));
        fs.unlinkSync(saved);
        return { entry, marker, copy, meta: JSON.parse(fs.readFileSync(path.join(priv, marker), 'utf8')) };
      };
      describe('#481 raw duplicate members', () => {
        // Insert RAW members into the actual writer bytes. JSON.stringify would erase this boundary.
        const member = (raw, field) => {
          const found = raw.match(new RegExp(`"${field}":(?:"[^"\\\\]*"|[0-9]+|null|\\{(?:[^{}]|\\{[^{}]*\\})*\\})`));
          expect(found, `writer member ${field}`).not.toBeNull();
          return found[0];
        };
        const duplicate = (raw, field, later) => {
          const first = member(raw, field);
          return raw.replace(first, `${first},${later ?? first}`);
        };
        const nestedDuplicate = (raw, parent, field, later) => {
          const object = member(raw, parent);
          return raw.replace(object, duplicate(object, field, later));
        };
        const saveProbe = (label, raw, before, reply) => {
          // Optional failing-first artifacts; fixtures remain under the test's ordinary TMPDIR otherwise.
          const out = process.env.COEDIT_FS_FIXTURE_OUT;
          if (!out) return;
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(path.join(out, `${label}.raw.json`), raw);
          fs.writeFileSync(path.join(out, `${label}.evidence.json`), JSON.stringify({ before, reply, after: evidence() }, null, 2));
        };
        const liveRetained = async (extra = {}, bound = true) => {
          if (bound) expect(await h.call({ op: 'hello', recovery: recoveryDir() })).toMatchObject({ ok: true });
          const reply = await publish(await read(), { txn: TXN, ack: sha('t'), ...extra });
          expect(reply).toMatchObject({ ok: true, published: true });
          const record = JSON.parse(fs.readFileSync(recordPath(), 'utf8'));
          // No testOrigin override: the writer records the genuine, still-live caller.
          expect(record).toMatchObject({ pid: process.pid, start: startOf(process.pid) });
          expect(fs.readFileSync(outcomePath(), 'utf8')).toBe('published');
          await h.stop();
          h = helper(root, priv); // Release the connection lock, NOT the origin's ownership.
          return reply.displaced;
        };
        const boundaries = [
          ['tokenless-list', { op: 'list' }],
          ['tokenless-dispose', { op: 'dispose' }],
          ['pending-ack', { op: 'ack', txn: TXN, token: 't' }],
        ];
        test.each(['plain', 'escaped'].flatMap((key) => boundaries.map(([label, request]) => [key, label, request])))('txn %s later empty ack refuses %s with a live token origin', async (key, label, request) => {
          const entry = await liveRetained();
          const original = fs.readFileSync(recordPath(), 'utf8');
          expect(JSON.parse(original).ack).toBe(sha('t'));
          const raw = duplicate(original, 'ack', key === 'plain' ? '"ack":""' : '"\\u0061ck":""');
          fs.writeFileSync(recordPath(), raw);
          const before = evidence();
          const reply = await h.call({ path: 'docs/a.md', entry, hash: sha('one\n'), ...request });
          saveProbe(`txn-${key}-${label}`, raw, before, reply);
          refused(reply, before, `${KEY}.${TXN}.txn`);
        });
        test.each([
          ['ino-identical', (raw) => duplicate(raw, 'ino'), { op: 'list', tokens: { [TXN]: 't' } }],
          ['dest-identical', (raw) => duplicate(raw, 'dest'), { op: 'dispose', token: 't' }],
          ['dest-ino-identical', (raw) => nestedDuplicate(raw, 'dest', 'ino'), { op: 'ack', txn: TXN, token: 't' }],
        ])('txn %s refuses the ownership operation without normalizing identical members', async (label, mutate, request) => {
          const entry = await liveRetained();
          const raw = mutate(fs.readFileSync(recordPath(), 'utf8'));
          fs.writeFileSync(recordPath(), raw);
          const before = evidence();
          const reply = await h.call({ path: 'docs/a.md', entry, hash: sha('one\n'), ...request });
          saveProbe(`txn-${label}`, raw, before, reply);
          refused(reply, before, `${KEY}.${TXN}.txn`);
        });
        test('txn identical ack refuses owned-here disposal', async () => {
          expect(await h.call({ op: 'hello', recovery: recoveryDir() })).toMatchObject({ ok: true });
          const reply = await publish(await read(), { txn: TXN, ack: sha('t') });
          expect(reply).toMatchObject({ ok: true, published: true });
          const raw = duplicate(fs.readFileSync(recordPath(), 'utf8'), 'ack');
          fs.writeFileSync(recordPath(), raw);
          const before = evidence();
          const disposed = await dispose(reply.displaced, sha('one\n'));
          saveProbe('txn-owned-here', raw, before, disposed);
          refused(disposed, before, `${KEY}.${TXN}.txn`);
        });
        test.each([
          ['record-identical', (raw) => duplicate(raw, 'record'), { op: 'list' }],
          ['record-escaped-ack-identical', (raw) => nestedDuplicate(raw, 'record', 'ack', member(raw, 'ack').replace('"ack"', '"\\u0061ck"')), { op: 'list' }],
          ['record-dest-ino-identical', (raw) => {
            const record = member(raw, 'record');
            return raw.replace(record, nestedDuplicate(record, 'dest', 'ino'));
          }, { op: 'list' }],
          ['copy-escaped-ino-identical', (raw) => nestedDuplicate(raw, 'copy', 'ino', member(member(raw, 'copy'), 'ino').replace('"ino"', '"\\u0069no"')), { op: 'list' }],
          ['copy-identical-dispose', (raw) => nestedDuplicate(raw, 'copy', 'ino'), { op: 'dispose', token: 't' }],
          ['record-identical-ack', (raw) => duplicate(raw, 'record'), { op: 'ack', txn: TXN, token: 't' }],
          ['record-dest-identical-tokenless-dispose', (raw) => nestedDuplicate(raw, 'record', 'dest'), { op: 'dispose' }],
        ])('done %s refuses the operation with the genuine copy and retained inode', async (label, mutate, request) => {
          const { entry, marker, copy, meta } = await delivered(true);
          expect(meta.copy).toEqual({ dev: fs.statSync(copy).dev, ino: fs.statSync(copy).ino });
          const raw = mutate(fs.readFileSync(path.join(priv, marker), 'utf8'));
          fs.writeFileSync(path.join(priv, marker), raw);
          const before = evidence();
          const reply = await h.call({ path: 'docs/a.md', entry, hash: sha('one\n'), ...request });
          saveProbe(`done-${label}`, raw, before, reply);
          refused(reply, before, marker);
        });
        test('control ordinary live-origin token ownership is not empty mode', async () => {
          const entry = await liveRetained();
          const before = evidence();
          expect(await h.call({ op: 'list', path: 'docs/a.md' })).toMatchObject({ ok: true, entries: [{ entry, owned: true }], recovered: [] });
          expect(await dispose(entry, sha('one\n'))).toMatchObject({ ok: false, owned: true });
          expect(evidence()).toEqual(before);
          expect(await h.call({ op: 'ack', path: 'docs/a.md', txn: TXN, token: 't' })).toMatchObject({ ok: true, pending: true });
          expect(evidence()).toEqual(before);
          expect(await h.call({ op: 'dispose', path: 'docs/a.md', entry, hash: sha('one\n'), token: 't' })).toMatchObject({ ok: true });
        });
        test('control explicit null dest with a nonempty token remains owned', async () => {
          const entry = await liveRetained({}, false);
          expect(JSON.parse(fs.readFileSync(recordPath(), 'utf8'))).toMatchObject({ ack: sha('t'), dest: null });
          const before = evidence();
          expect(await h.call({ op: 'list', path: 'docs/a.md' })).toMatchObject({ ok: true, entries: [{ entry, owned: true }], recovered: [] });
          expect(await dispose(entry, sha('one\n'))).toMatchObject({ ok: false, owned: true });
          expect(evidence()).toEqual(before);
          expect(await h.call({ op: 'dispose', path: 'docs/a.md', entry, hash: sha('one\n'), token: 't' })).toMatchObject({ ok: true });
        });
        test('control omitted request ack writes explicit empty ack and null dest', async () => {
          const entry = await liveRetained({ ack: undefined }, false);
          expect(JSON.parse(fs.readFileSync(recordPath(), 'utf8'))).toMatchObject({ ack: '', dest: null });
          expect(await h.call({ op: 'list', path: 'docs/a.md' })).toMatchObject({ ok: true, entries: [{ entry, hash: sha('one\n') }], recovered: [] });
          expect(await dispose(entry, sha('one\n'))).toMatchObject({ ok: true });
        });
      });

      describe('#481 P1 unlinked delivery', () => {
        test.each(['fresh', 'retry', 'dispose'])('%s protects exact late bytes after open then last-name unlink', async (phase) => {
          const late = Buffer.from('one\nlate-only-P1\n');
          expect(await h.call({ op: 'hello', recovery: recoveryDir() })).toMatchObject({ ok: true });
          const writer = fs.openSync(target(), 'a');
          let p;
          try {
            p = await publish(await read(), { txn: TXN, ack: sha('t'), testOrigin: gone() });
            expect(p).toMatchObject({ ok: true, published: true });
            fs.writeSync(writer, late.subarray(Buffer.byteLength('one\n')));
          } finally {
            fs.closeSync(writer);
          }
          await h.finish();
          h = helper(root, priv);
          // Publish a genuine receipt without removing retained data. No fixture backup/hard link remains.
          if (phase !== 'fresh') {
            expect(await h.call({ op: 'list', path: 'docs/a.md', fault: 'privSync' })).toMatchObject({ ok: false });
            expect(fs.readdirSync(priv).filter((n) => n.endsWith('.done'))).toHaveLength(1);
          }
          expect(fs.readFileSync(path.join(priv, p.displaced))).toEqual(late);
          expect(fs.statSync(path.join(priv, p.displaced)).nlink).toBe(1);
          const socketPath = path.join(dir, 'delivery-gate.sock');
          let opened = 0, removed, gateError;
          // A retry/dispose first verifies during preflight. Unlink during the verification authorizing removal.
          const unlinkAt = phase === 'fresh' ? 1 : 2;
          const server = createServer((socket) => {
            createInterface({ input: socket }).once('line', (line) => {
              try {
                opened += 1;
                const { path: copy } = JSON.parse(line);
                if (opened === unlinkAt) {
                  expect(fs.statSync(copy).nlink).toBe(1);
                  expect(fs.readFileSync(copy)).toEqual(late);
                  fs.unlinkSync(copy);
                  expect(fs.existsSync(copy)).toBe(false);
                  removed = copy;
                }
              } catch (error) { gateError = error; }
              socket.end('r'); // Only now do the helper's first fstat, checks and disposal run.
            });
          });
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
          try {
            const reply = await h.call({ op: phase === 'dispose' ? 'dispose' : 'list', path: 'docs/a.md',
              entry: p.displaced, hash: sha(late), token: phase === 'dispose' ? 't' : undefined,
              gate: 'deliveryOpened', gateSocket: socketPath });
            expect(gateError).toBeUndefined();
            expect(opened).toBe(unlinkAt);
            expect(removed).toBeTruthy();
            // Let every delivery fd close. Only durable names in the helper's private dir count as protection.
            await h.finish();
            const protectedBytes = () => fs.readdirSync(priv).filter((n) => n.endsWith('.staged') || n.endsWith('.anchor'))
              .map((n) => fs.readFileSync(path.join(priv, n)));
            console.log(`P1 ${phase}: reply=${JSON.stringify(reply)} protectedCopies=${protectedBytes().length}`);
            expect(protectedBytes(), 'last-name unlink must not erase the only late bytes').toContainEqual(late);
            h = helper(root, priv);
            await h.call({ op: 'list', path: 'docs/a.md' }); // A later retry cannot consume the protection.
            await h.call({ op: 'dispose', path: 'docs/a.md', entry: p.displaced, hash: sha(late), token: 't' });
            await h.call({ op: 'ack', path: 'docs/a.md', txn: TXN, token: 't' });
            await h.finish();
            expect(protectedBytes()).toContainEqual(late);
          } finally {
            await new Promise((resolve) => server.close(resolve));
          }
        });
      });

      describe('#481 P1 protected copy', () => {
        test.each(['anchorCreate', 'anchorSync'])('%s failure keeps retained bytes until protection is durable', async (fault) => {
          const { entry, marker, copy } = await delivered(true);
          const anchor = path.join(priv, `${marker}.anchor`);
          fs.unlinkSync(anchor); // A legacy/interrupted retry has a real receipt but no anchor yet.
          for (let retry = 0; retry < 2; retry += 1) {
            expect(await h.call({ op: 'list', path: 'docs/a.md', fault })).toMatchObject({ ok: false, error: expect.stringContaining(`${marker}.anchor`) });
            expect(fs.readFileSync(path.join(priv, entry), 'utf8')).toBe('one\n');
          }
          expect(await h.call({ op: 'list', path: 'docs/a.md' })).toMatchObject({ ok: true, entries: [], recovered: [{ marker, path: copy }] });
          expect(fs.readFileSync(anchor, 'utf8')).toBe('one\n');
          expect(fs.existsSync(path.join(priv, entry))).toBe(false);
          expect(fs.statSync(anchor).ino).not.toBe(fs.statSync(copy).ino);
          expect(fs.statSync(anchor).mode & 0o7777).toBe(0o600);
          expect(getXattr(anchor, 'system.posix_acl_access')).toBe('none');
        });
        test.each(['bytes', 'mode', 'link'])('an existing anchor with changed %s cannot authorize retained unlink', async (kind) => {
          const { entry, marker, copy } = await delivered(true);
          const anchor = path.join(priv, `${marker}.anchor`);
          if (kind === 'bytes') fs.writeFileSync(anchor, 'altered\n');
          if (kind === 'mode') fs.chmodSync(anchor, 0o640);
          if (kind === 'link') { fs.unlinkSync(anchor); fs.symlinkSync(copy, anchor); }
          const before = evidence();
          refused(await h.call({ op: 'list', path: 'docs/a.md' }), before, `${marker}.anchor`);
          expect(fs.readFileSync(path.join(priv, entry), 'utf8')).toBe('one\n');
        });
        test('the served protocol cannot dispose an anchor and receipt retirement cannot release it', async () => {
          const { marker, copy } = await delivered(false);
          const anchor = path.join(priv, `${marker}.anchor`);
          expect(await dispose(`${marker}.anchor`, sha('one\n'))).toMatchObject({ ok: false, error: 'invalid entry' });
          expect(await h.call({ op: 'ack', path: 'docs/a.md', txn: TXN, token: 't' })).toMatchObject({ ok: true, pending: false });
          fs.unlinkSync(copy);
          expect(await h.call({ op: 'list', path: 'docs/a.md' })).toMatchObject({ ok: true, entries: [], records: [], recovered: [] });
          await h.finish();
          expect(fs.readFileSync(anchor, 'utf8')).toBe('one\n');
        });
      });

      const invalidDone = [
        ['invalid JSON', () => '{'],
        ...[null, [], true, 1, 'marker'].map((value) => [`root ${JSON.stringify(value)}`, () => value]),
        ...['path', 'hash'].map((field) => [`missing ${field}`, missing(field)]),
        ['unknown field', set('unexpected', true)],
        ...[null, 1, [], '', 'relative'].map((value) => [`path ${JSON.stringify(value)}`, set('path', value)]),
        ...[null, 1, [], '', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)].map((value) => [`hash ${JSON.stringify(value)}`, set('hash', value)]),
        ['matching marker name but wrong hash', set('hash', sha('different\n'))],
        ['path outside the bound destination', (meta) => {
          const copy = path.join(dir, path.basename(meta.path));
          fs.copyFileSync(meta.path, copy);
          return { ...meta, path: copy };
        }],
        ['path names another transaction', (meta) => {
          const copy = meta.path.replace(`-rec${TXN}`, '-recffffff');
          expect(copy).not.toBe(meta.path);
          fs.renameSync(meta.path, copy);
          return { ...meta, path: copy };
        }],
        ['absent delivered copy', (meta) => { fs.unlinkSync(meta.path); return meta; }],
        ['changed delivered copy', (meta) => { fs.writeFileSync(meta.path, 'changed\n'); return meta; }],
      ];

      // Mutate actual version-1 writer output. Path/hash regressions above stay unchanged.
      const recordMutation = (mutate) => (meta) => ({ ...meta, record: mutate(meta.record) });
      const copySet = (field, value) => (meta) => ({ ...meta, copy: { ...meta.copy, [field]: value } });
      const invalidDoneSchema = [
        ...['version', 'key', 'txn', 'record', 'copy'].map((field) => [`missing ${field}`, missing(field)]),
        ['legacy path/hash-only marker', (meta) => ({ path: meta.path, hash: meta.hash })],
        ...fields.map((field) => [`missing record.${field}`, recordMutation(missing(field))]),
        ...['path', 'dev', 'ino'].map((field) => [`missing record.dest.${field}`, recordMutation((record) => ({ ...record, dest: missing(field)(record.dest) }))]),
        ...['dev', 'ino'].map((field) => [`missing copy.${field}`, (meta) => ({ ...meta, copy: missing(field)(meta.copy) })]),
        ['extra record field', recordMutation(set('unexpected', true))],
        ['extra record.dest field', recordMutation(destSet('unexpected', true))],
        ['extra copy field', copySet('unexpected', true)],
        ...[null, '1', 0, 2, 1.5].map((value) => [`version ${JSON.stringify(value)}`, set('version', value)]),
        ...[null, 16, '', 'a'.repeat(15), 'A'.repeat(16), 'g'.repeat(16)].map((value) => [`key ${JSON.stringify(value)}`, set('key', value)]),
        ['key names another file', (meta) => ({ ...meta, key: `${meta.key[0] === 'f' ? 'e' : 'f'}${meta.key.slice(1)}` })],
        ['key too long', set('key', 'a'.repeat(17))],
        ...[null, 1, '', 'A', 'g', 'a'.repeat(33)].map((value) => [`txn ${JSON.stringify(value)}`, set('txn', value)]),
        ['txn differs from marker filename', set('txn', 'ffffff')],
        ...[null, []].map((value) => [`record ${JSON.stringify(value)}`, set('record', value)]),
        ...[null, []].map((value) => [`copy ${JSON.stringify(value)}`, set('copy', value)]),
        ['record.ino wrong type', recordMutation(set('ino', '1'))],
        ['record.ino zero', recordMutation(set('ino', 0))],
        ['record.ino overflow', recordMutation(set('ino', 18446744073709551616))],
        ['record.ack wrong type', recordMutation(set('ack', null))],
        ['record.ack short', recordMutation(set('ack', 'a'.repeat(63)))],
        ['record.pid wrong type', recordMutation(set('pid', true))],
        ['record.pid exceeds i32', recordMutation(set('pid', 2147483648))],
        ['record.pid negative', recordMutation(set('pid', -1))],
        ['record unknown pid with nonzero start', recordMutation((record) => ({ ...record, pid: 0, start: 1 }))],
        ['record.start fractional', recordMutation(set('start', 1.5))],
        ['record.start negative', recordMutation(set('start', -1))],
        ['record.start overflow', recordMutation(set('start', 18446744073709551616))],
        ['record.dest wrong type', recordMutation(set('dest', []))],
        ['record.dest null cannot authorize delivery', recordMutation(set('dest', null))],
        ['record.dest.path wrong type', recordMutation(destSet('path', false))],
        ['record.dest.path noncanonical', recordMutation((record) => ({ ...record, dest: { ...record.dest, path: `${record.dest.path}/.` } }))],
        ['record.dest.dev wrong type', recordMutation(destSet('dev', '1'))],
        ['record.dest.dev negative', recordMutation(destSet('dev', -1))],
        ['record.dest.dev overflow', recordMutation(destSet('dev', 18446744073709551616))],
        ['record.dest.ino wrong type', recordMutation(destSet('ino', '1'))],
        ['record.dest.ino zero', recordMutation(destSet('ino', 0))],
        ['record.dest.ino overflow', recordMutation(destSet('ino', 18446744073709551616))],
        ...['dev', 'ino'].flatMap((field) => [null, '1', -1, 1.5, 18446744073709551616].map((value) => [`copy.${field} ${JSON.stringify(value)}`, copySet(field, value)])),
        ['copy.ino zero', copySet('ino', 0)],
        ...['ino', 'pid', 'start'].map((field) => [`record.${field} differs from txn snapshot`, recordMutation((record) => ({ ...record, [field]: record[field] + 1 }))]),
        ['record.ack differs from txn snapshot', recordMutation(set('ack', sha('another token')))],
        ['record.dest.path differs from bound directory', recordMutation((record) => ({ ...record, dest: { ...record.dest, path: `${record.dest.path}-other` } }))],
        ...['dev', 'ino'].map((field) => [`record.dest.${field} differs from bound directory`, recordMutation((record) => ({ ...record, dest: { ...record.dest, [field]: record.dest[field] + 1 } }))]),
        ...['dev', 'ino'].map((field) => [`copy.${field} differs from delivered inode`, (meta) => ({ ...meta, copy: { ...meta.copy, [field]: meta.copy[field] + 1 } })]),
      ];
      test.each(invalidDoneSchema)('version-1 done list refuses %s and retains all evidence', async (_label, mutate) => {
        const { marker, meta } = await delivered(true);
        expect(meta).toMatchObject({ version: 1, key: KEY, txn: TXN, record: JSON.parse(fs.readFileSync(recordPath(), 'utf8')),
          copy: { dev: fs.statSync(meta.path).dev, ino: fs.statSync(meta.path).ino } });
        writeRecord(path.join(priv, marker), mutate(meta));
        const before = evidence();
        refused(await h.call({ op: 'list', path: 'docs/a.md' }), before, marker);
      });
      describe.each([false, true])('done retry with staged entry %s', (retry) => {
        test.each(invalidDone)('list refuses %s and retains the marker and remaining evidence', async (_label, mutate) => {
          const { marker, meta } = await delivered(retry);
          writeRecord(path.join(priv, marker), mutate(meta));
          const before = evidence();
          refused(await h.call({ op: 'list', path: 'docs/a.md' }), before, marker);
        });
      });
      test.each(invalidDone.filter(([label]) => ['invalid JSON', 'matching marker name but wrong hash', 'absent delivered copy', 'changed delivered copy'].includes(label)))('tokenless dispose refuses %s before orphan unlink', async (_label, mutate) => {
        const { entry, marker, meta } = await delivered(true);
        writeRecord(path.join(priv, marker), mutate(meta));
        const before = evidence();
        refused(await h.call({ op: 'dispose', path: 'docs/a.md', entry, hash: sha('one\n') }), before, marker);
      });

      test('valid counterexample: done remains listable after txn ack retirement, but a pruned copy is not a fresh delivery', async () => {
        const { marker, copy } = await delivered(false);
        expect(await h.call({ op: 'ack', path: 'docs/a.md', txn: TXN, token: 't' })).toMatchObject({ ok: true, pending: false });
        expect(fs.existsSync(recordPath())).toBe(false);
        expect(fs.existsSync(outcomePath())).toBe(false);
        const before = evidence();
        const seen = await h.call({ op: 'list', path: 'docs/a.md' });
        expect(seen).toMatchObject({ ok: true, records: [], entries: [], recovered: [{ marker, path: copy, hash: sha('one\n') }] });
        expect(evidence()).toEqual(before);
        fs.unlinkSync(copy); // Legitimate pruning after retirement, with NO retained bytes.
        const pruned = evidence();
        expect(await h.call({ op: 'list', path: 'docs/a.md' })).toMatchObject({ ok: true, records: [], entries: [], recovered: [] });
        expect(evidence()).toEqual(pruned);
      });

      test('a missing delivered copy with retained bytes refuses even after the txn was previously retired', async () => {
        const entry = await retained('published');
        const record = fs.readFileSync(recordPath());
        const outcome = fs.readFileSync(outcomePath());
        const saved = path.join(dir, 'retained-before-retirement');
        fs.linkSync(path.join(priv, entry), saved);
        const seen = await h.call({ op: 'list', path: 'docs/a.md' });
        expect(seen).toMatchObject({ ok: true, entries: [], recovered: [{ hash: sha('one\n') }] });
        const [{ marker, path: copy }] = seen.recovered;
        expect(await h.call({ op: 'ack', path: 'docs/a.md', txn: TXN, token: 't' })).toMatchObject({ ok: true, pending: false });
        fs.linkSync(saved, path.join(priv, entry));
        fs.unlinkSync(saved);
        // Restore the writer's exact evidence for the interrupted-unlink state; no missing-record fallback.
        fs.writeFileSync(recordPath(), record, { mode: 0o600 });
        fs.writeFileSync(outcomePath(), outcome, { mode: 0o600 });
        fs.unlinkSync(copy);
        const before = evidence();
        refused(await h.call({ op: 'list', path: 'docs/a.md' }), before, marker);
        refused(await h.call({ op: 'dispose', path: 'docs/a.md', entry, hash: sha('one\n') }), before, marker);
      });

      test.each(['list', 'dispose', 'ack'])('missing txn record refuses %s without touching retained bytes or outcome', async (op) => {
        const entry = await retained('published');
        fs.unlinkSync(recordPath());
        const before = evidence();
        refused(await h.call({ op, path: 'docs/a.md', entry, hash: sha('one\n'), txn: TXN, token: 't' }), before, `${KEY}.${TXN}.txn`);
      });

      test('owned-here disposal validates a malformed record before using its live-connection authority', async () => {
        expect(await h.call({ op: 'hello', recovery: recoveryDir() })).toMatchObject({ ok: true });
        const reply = await publish(await read(), { txn: TXN, ack: sha('t') });
        expect(reply).toMatchObject({ ok: true, published: true });
        writeRecord(recordPath(), missing('ack')(JSON.parse(fs.readFileSync(recordPath(), 'utf8'))));
        const before = evidence();
        refused(await h.call({ op: 'dispose', path: 'docs/a.md', entry: reply.displaced, hash: sha('one\n') }), before, `${KEY}.${TXN}.txn`);
      });

      test.each(['txn', 'done'])('malformed fileA %s evidence does not block a valid publish and disposal for fileB', async (kind) => {
        let name;
        if (kind === 'txn') {
          await retained('published');
          name = `${KEY}.${TXN}.txn`;
          writeRecord(recordPath(), missing('ack')(JSON.parse(fs.readFileSync(recordPath(), 'utf8'))));
        } else {
          const { marker, meta } = await delivered(true);
          name = marker;
          writeRecord(path.join(priv, marker), missing('version')(meta));
        }
        const before = evidence();
        refused(await h.call({ op: 'list', path: 'docs/a.md' }), before, name);
        fs.writeFileSync(path.join(root, 'docs/b.md'), 'B\n');
        const base = await h.call({ op: 'read', path: 'docs/b.md' });
        expect(base).toMatchObject({ ok: true, hash: sha('B\n') });
        const reply = await h.call({ op: 'publish', path: 'docs/b.md', ino: base.ino, dev: base.dev, hash: base.hash,
          txn: '46bbbb', ack: '', data: Buffer.from('B2\n').toString('base64') });
        expect(reply).toMatchObject({ ok: true, published: true });
        expect(await h.call({ op: 'dispose', path: 'docs/b.md', entry: reply.displaced, hash: sha('B\n') })).toMatchObject({ ok: true });
        expect(await h.call({ op: 'list', path: 'docs/b.md' })).toMatchObject({ ok: true, entries: [], records: [], recovered: [] });
        expect(fs.readFileSync(path.join(root, 'docs/b.md'), 'utf8')).toBe('B2\n');
        const after = evidence();
        expect(after.private).toEqual(before.private);
        expect(after.delivered).toEqual(before.delivered);
        expect(after.project.filter(({ name }) => name === 'a.md')).toEqual(before.project);
      });

      test.each(['recordSync', 'deliverSync', 'dirSync', 'privSync'])('valid counterexample: prior delivery %s failure retains evidence until a successful retry', async (fault) => {
        const { entry, marker, copy } = await delivered(true);
        const before = evidence();
        refused(await h.call({ op: 'list', path: 'docs/a.md', fault }), before, marker);
        const seen = await h.call({ op: 'list', path: 'docs/a.md' });
        expect(seen).toMatchObject({ ok: true, entries: [], recovered: [{ marker, path: copy, hash: sha('one\n') }] });
        const after = evidence();
        expect(after.private).toEqual(before.private.filter(({ name }) => name !== entry));
        expect(after.delivered).toEqual(before.delivered);
        expect(after.project).toEqual(before.project);
      });

      test.each([
        ['unknown origin 0,0', [0, 0]],
        ['unknown start of a live pid', [process.pid, 0]],
      ])('valid counterexample: writer-generated %s stays owned and never grants orphan recovery', async (_label, origin) => {
        const reply = await orphanWithOrigin(TXN, origin);
        expect(reply).toMatchObject({ ok: true, published: true });
        expect(JSON.parse(fs.readFileSync(recordPath(), 'utf8'))).toMatchObject({ pid: origin[0], start: origin[1] });
        const before = evidence();
        expect(await h.call({ op: 'list', path: 'docs/a.md' })).toMatchObject({ ok: true, entries: [{ entry: reply.displaced, owned: true }], recovered: [] });
        expect(evidence()).toEqual(before);
      });
      test('valid counterexample: true orphan recovery and already-delivered done retry preserve the generated copy', async () => {
        const { entry, marker, copy } = await delivered(true);
        const before = evidence();
        const seen = await h.call({ op: 'list', path: 'docs/a.md' });
        expect(seen).toMatchObject({ ok: true, entries: [], records: [{ txn: TXN, state: 'published' }], recovered: [{ marker, path: copy, hash: sha('one\n') }] });
        const after = evidence();
        expect(after.private).toEqual(before.private.filter(({ name }) => name !== entry));
        expect(after.delivered).toEqual(before.delivered);
        expect(after.project).toEqual(before.project);
        expect((await h.call({ op: 'list', path: 'docs/a.md' })).recovered).toEqual(seen.recovered);
      });
      test.each(['aborted', 'published'])('valid counterexample: %s accepts explicit empty ack and null dest, never missing fields', async (state) => {
        // No hello recovery and an explicit empty ack: obtain both modes from the writer, not a mutated record.
        const r = await read();
        let ownedEntry;
        if (state === 'published') {
          const reply = await publish(r, { txn: TXN, ack: '' });
          expect(reply).toMatchObject({ ok: true, published: true });
          ownedEntry = reply.displaced;
        } else {
          void publish(r, { txn: TXN, ack: '', pause: 'beforeExchange', pauseMs: 5000 });
          await until(() => staged().length === 1);
          [ownedEntry] = staged();
        }
        await h.stop();
        h = helper(root, priv);
        const record = JSON.parse(fs.readFileSync(recordPath(), 'utf8'));
        expect(record).toMatchObject({ ack: '', dest: null, ino: expect.any(Number), pid: expect.any(Number), start: expect.any(Number) });
        const bytes = fs.readFileSync(path.join(priv, ownedEntry));
        const seen = await h.call({ op: 'list', path: 'docs/a.md' });
        expect(seen).toMatchObject({ ok: true, records: [{ txn: TXN, state }], entries: [{ entry: ownedEntry, hash: sha(bytes) }], recovered: [] });
        expect(await dispose(ownedEntry, sha(bytes))).toMatchObject({ ok: true });
      });
    });

    test('smartyfs#32 pre-enable: a live originating process keeps its transaction; its pid reused by another process counts as gone', async () => {
      const alive = await orphanWithOrigin('a1a1a1', [process.pid, startOf(process.pid)]);
      const first = await h.call({ op: 'list', path: 'docs/a.md' });
      expect(first.entries).toEqual([{ entry: alive.displaced, owned: true }]);
      expect(first.recovered).toEqual([]); // A live origin: nothing is recovered but by its token holder.
      const reused = await orphanWithOrigin('a2a2a2', [process.pid, startOf(process.pid) + 1]); // Same pid, another start.
      const seen = await h.call({ op: 'list', path: 'docs/a.md' });
      expect(seen.entries).toEqual([{ entry: alive.displaced, owned: true }]); // The reused one's entry was recovered.
      expect(seen.recovered.map((r) => r.marker)).toEqual([expect.stringMatching(new RegExp(`^${KEY}\\.a2a2a2\\.`))]);
      expect(seen.entries.find((e) => e.entry === reused.displaced)).toBeUndefined();
    });

    test('#428 round 1, finding 2: a live origin hidden by procfs (ENOENT, as hidepid does) counts as alive; only ESRCH is exit', async () => {
      const hidden = await orphanWithOrigin('a3a3a3', [process.pid, startOf(process.pid)]);
      const seen = await h.call({ op: 'list', path: 'docs/a.md', fault: 'procHidden' });
      expect(seen.entries).toEqual([{ entry: hidden.displaced, owned: true }]);
      expect(seen.recovered).toEqual([]);
      expect(await h.call({ op: 'dispose', path: 'docs/a.md', entry: hidden.displaced, hash: 'x', fault: 'procHidden' })).toMatchObject({ ok: false, owned: true });
      expect(staged()).toContain(hidden.displaced);
      const gone = await orphanWithOrigin('a4a4a4', [999_999_999, 1]); // kill(pid, 0) says ESRCH: really gone.
      const after = await h.call({ op: 'list', path: 'docs/a.md', fault: 'procHidden' });
      expect(after.recovered.map((r) => r.marker)).toEqual([expect.stringMatching(new RegExp(`^${KEY}\\.a4a4a4\\.`))]);
      expect(staged()).not.toContain(gone.displaced);
      expect(staged()).toContain(hidden.displaced);
    });

    test('#412 round 2, finding 2: bye is answered only after the operation in flight, and then the helper exits', async () => {
      const r = await read();
      const child = spawn(BIN, ['--same-account', root, priv], { env: { ...process.env, COEDIT_FS_TEST: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
      const replies = [];
      createInterface({ input: child.stdout }).on('line', (l) => replies.push(JSON.parse(l)));
      const exited = new Promise((done) => child.on('exit', done));
      child.stdin.write(`${JSON.stringify({ op: 'publish', path: 'docs/a.md', ino: r.ino, dev: r.dev, hash: r.hash, data: Buffer.from('two\n').toString('base64'), pause: 'afterExchange', pauseMs: 800, id: 1 })}\n`);
      child.stdin.write(`${JSON.stringify({ op: 'bye', id: 2 })}\n`);
      await exited;
      expect(replies.map((x) => x.id)).toEqual([1, 2]);
      expect(replies[0]).toMatchObject({ published: true });
      expect(replies[1]).toMatchObject({ ok: true, bye: true });
    });

    test('an ACL on a path directory that names only trusted accounts (the helper, its peer) is allowed', async () => {
      const r = await read();
      setAcl(root, 'system.posix_acl_access', [[ACL.USER_OBJ, 7, ANY], [ACL.USER, 7, process.geteuid()], [ACL.GROUP_OBJ, 5, ANY], [ACL.MASK, 7, ANY], [ACL.OTHER, 5, ANY]]);
      expect(await publish(r)).toMatchObject({ ok: true });
    });

    /** acl(5)'s access check, as the effective permission set of `who` ({uid, gids}) on a file (owner, gid, ACL hex). */
    const effective = ({ owner, gid, acl }, who) => {
      const entries = [];
      for (let i = 8; i < acl.length; i += 16) {
        const e = Buffer.from(acl.slice(i, i + 16), 'hex');
        entries.push({ tag: e.readUInt16LE(0), perm: e.readUInt16LE(2), id: e.readUInt32LE(4) });
      }
      const find = (tag) => entries.filter((e) => e.tag === tag);
      const mask = find(ACL.MASK)[0]?.perm ?? 7;
      if (who.uid === owner) return find(ACL.USER_OBJ)[0].perm;
      const user = find(ACL.USER).find((e) => e.id === who.uid);
      if (user) return user.perm & mask;
      const groups = [...find(ACL.GROUP_OBJ).map((e) => ({ ...e, id: gid })), ...find(8)].filter((e) => who.gids.includes(e.id));
      if (groups.length) return groups.reduce((m, e) => m | (e.perm & mask), 0);
      return find(ACL.OTHER)[0].perm;
    };

    test('#412 finding 2: another owner\'s file keeps every principal\'s EFFECTIVE access, masked bits stay masked', async () => {
      // The original: owner 4242 rw; user 4243 raw rw but masked to r; owning group r; group 4244 raw rw masked to r.
      const { gid } = fs.statSync(target());
      setAcl(target(), 'system.posix_acl_access', [[ACL.USER_OBJ, 6, ANY], [ACL.USER, 6, 4243], [ACL.GROUP_OBJ, 4, ANY], [8, 6, 4244], [ACL.MASK, 4, ANY], [ACL.OTHER, 0, ANY]]);
      const before = { owner: 4242, gid, acl: getXattr(target(), 'system.posix_acl_access') };
      const r = await h.call({ op: 'read', path: 'docs/a.md' });
      // testFileOwner stands in for paul's file seen by the smarty-coedit helper; the real-uid run is on forge.
      expect(await publish(r, { testFileOwner: 4242 })).toMatchObject({ ok: true });
      const after = { owner: process.geteuid(), gid: fs.statSync(target()).gid, acl: getXattr(target(), 'system.posix_acl_access') };
      const principals = [
        { uid: 4242, gids: [] }, // The original owner: rw, not subject to the old mask.
        { uid: 4243, gids: [] }, // Named, raw rw, masked to r: must stay r.
        { uid: 5000, gids: [gid] }, // A member of the owning group: r.
        { uid: 5001, gids: [4244] }, // A named group's member, raw rw, masked to r: must stay r.
        { uid: 5002, gids: [] }, // Anyone else: nothing.
      ];
      for (const who of principals) expect([who.uid, effective(after, who)]).toEqual([who.uid, effective(before, who)]);
      expect(effective(after, { uid: 4243, gids: [] })).toBe(4);
    });
  });
});
