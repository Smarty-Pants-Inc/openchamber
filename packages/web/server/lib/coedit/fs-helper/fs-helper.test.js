// openchamber#380: the coedit-fs helper against a real Linux filesystem (protocol: coedit DOCUMENTATION.md).
// Builds the helper first (ensure-built.js); without cargo they skip locally and fail in CI.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureHelper } from './ensure-built.js';

const BIN = path.join(import.meta.dirname, 'target/release/coedit-fs');
const built = ensureHelper() && fs.existsSync(BIN);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const KEY = sha('docs/a.md').slice(0, 16);

function helper(root, priv) {
  const child = spawn(BIN, [root, priv], { env: { ...process.env, COEDIT_FS_TEST: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
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
  return { call, raw, stop: () => child.kill() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond) => {
  for (let i = 0; i < 250 && !cond(); i += 1) await sleep(20);
  expect(cond()).toBe(true);
};

describe.skipIf(!built)('coedit-fs (openchamber#380)', () => {
  let dir, root, priv, h;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-fs-'));
    root = path.join(dir, 'project');
    priv = path.join(dir, 'recovery/.staging');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(priv, { recursive: true });
    fs.chmodSync(priv, 0o700);
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'one\n');
    h = helper(root, priv);
  });
  afterEach(() => { h.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  const target = () => path.join(root, 'docs/a.md');
  const docs = () => fs.readdirSync(path.join(root, 'docs')).sort();
  const staged = () => fs.readdirSync(priv);
  const read = async () => {
    const r = await h.call({ op: 'read', path: 'docs/a.md' });
    expect(r.ok).toBe(true);
    expect(Buffer.from(r.data, 'base64').toString()).toBe('one\n');
    expect(r.hash).toBe(sha('one\n'));
    return r;
  };
  const publish = (r, extra = {}) =>
    h.call({ op: 'publish', path: 'docs/a.md', key: KEY, ino: r.ino, dev: r.dev, hash: r.hash, data: Buffer.from('two\n').toString('base64'), ...extra });
  const dispose = (entry, hash) => h.call({ op: 'dispose', key: KEY, entry, hash });
  const replace = (text) => {
    fs.writeFileSync(path.join(root, 'docs/e.tmp'), text);
    fs.renameSync(path.join(root, 'docs/e.tmp'), target());
  };

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
    expect(await h.call({ op: 'list', key: KEY })).toMatchObject({ ok: true, entries: [{ entry: p.displaced, hash: sha('one\n') }] });
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

  test('a plain publish is synced; a dispose whose private-dir sync fails says so (synced: false)', async () => {
    const r = await read();
    const p = await publish(r);
    expect(p).toMatchObject({ ok: true, published: true, synced: true });
    expect(await h.call({ op: 'dispose', key: KEY, entry: p.displaced, hash: r.hash, fault: 'privSync' })).toMatchObject({ ok: true, synced: false });
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
    expect((await h.call({ op: 'dispose', key: '../x', entry: '../x.1', hash: 'x' })).ok).toBe(false);
    expect((await h.call({ op: 'list', key: '..' })).ok).toBe(false);
    expect(fs.readFileSync(path.join(root, 'docs/.a.md.coedit-foo'), 'utf8')).toBe('mine\n');
    expect(fs.readFileSync(path.join(dir, 'recovery/outside'), 'utf8')).toBe('out\n');
    expect(docs()).toEqual(['.a.md.coedit-foo', 'a.md']);
    expect((await h.call({ op: 'list', key: KEY })).entries.map((e) => e.entry)).toEqual([p.displaced]);
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
    const r = await read();
    expect((await publish(r, { key: 'ZZ/..' })).ok).toBe(false);
    expect(await h.raw('{not json')).toMatchObject({ ok: false, error: 'invalid json' });
    expect(fs.readFileSync(target(), 'utf8')).toBe('one\n');
    expect(staged()).toEqual([]);
  });

  test('the helper exits 2 on a private dir with group/other bits, or none given', () => {
    const loose = path.join(dir, 'loose');
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o750);
    expect(spawnSync(BIN, [root, loose], { input: '' }).status).toBe(2);
    expect(spawnSync(BIN, [root], { input: '' }).status).toBe(2);
    expect(spawnSync(BIN, [root, path.join(dir, 'missing')], { input: '' }).status).toBe(2);
    fs.symlinkSync(priv, path.join(dir, 'privlink'));
    expect(spawnSync(BIN, [root, path.join(dir, 'privlink')], { input: '' }).status).toBe(2);
  });
});
