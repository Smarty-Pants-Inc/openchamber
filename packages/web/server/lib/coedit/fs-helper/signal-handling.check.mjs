// Signal-handling UNIT only: self-raise after genuine delivery, not a kernel-break experiment.
// Run with COEDIT_SIGNAL_BIN pointing at a private instrumented helper. No builds or external signals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = process.env.COEDIT_SIGNAL_BIN;
assert.ok(BIN, 'COEDIT_SIGNAL_BIN must name the private instrumented helper');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const HERE = fileURLToPath(import.meta.url);
function connect(root, priv, blocked = false) {
  const args = ['--same-account', root, priv];
  const child = blocked
    ? spawn('python3', ['-c', 'import os,signal,sys\nsignal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGIO})\nos.execv(sys.argv[1],sys.argv[1:])', BIN, ...args], { env: { ...process.env, COEDIT_FS_TEST: '1' } })
    : spawn(BIN, args, { env: { ...process.env, COEDIT_FS_TEST: '1' } });
  const responses = [];
  const pending = new Map();
  let stderr = '', next = 0;
  child.stderr.on('data', (b) => { stderr += b; });
  child.stdin.on('error', () => {}); // Death before a reply is an observed result, not an unhandled EPIPE.
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const reply = JSON.parse(line);
    responses.push(reply);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      lines.close();
      for (const resolveReply of pending.values()) resolveReply(null);
      pending.clear();
      resolve({ code, signal, stderr, responses });
    });
  });
  return {
    call: (req) => new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
    }),
    finish: async () => { child.stdin.end(); return closed; },
  };
}
async function originate(root, priv, recovery) {
  const h = connect(root, priv);
  try {
    assert.deepEqual(await h.call({ op: 'hello', recovery }), { ok: true, protocol: 3, id: 1 });
    const read = await h.call({ op: 'read', path: 'a.md' });
    assert.equal(read.hash, sha('aQ'));
    const published = await h.call({ op: 'publish', path: 'a.md', ino: read.ino, dev: read.dev, hash: read.hash,
      data: Buffer.from('Pa').toString('base64'), txn: 'a0a0a0', ack: sha('synthetic-origin-token') });
    assert.equal(published.ok, true);
    assert.equal(published.published, true);
    // Deliberate synthetic expected-hash mismatch; no competing writer and no bytes changed after publish.
    const mismatch = await h.call({ op: 'dispose', path: 'a.md', entry: published.displaced, hash: sha('a') });
    assert.equal(mismatch.changed, true);
    assert.equal(mismatch.hash, sha('aQ'));
    assert.equal(Buffer.from(mismatch.data, 'base64').toString(), 'aQ');
    return { published, mismatch, originPid: process.pid };
  } finally {
    const exit = await h.finish();
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
  }
}
async function originChild(root, priv, recovery) {
  const child = spawn(process.execPath, [HERE, '--origin', root, priv, recovery], { env: process.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  child.stdin.end();
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  return JSON.parse(stdout);
}
function fixture(label) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'signal-unit-'));
  const root = path.join(dir, 'project'), priv = path.join(dir, 'private'), recovery = path.join(dir, 'recovery');
  for (const p of [root, priv, recovery]) fs.mkdirSync(p, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'a.md'), 'aQ', { mode: 0o600 });
  return { dir, root, priv, recovery, label };
}
function cleanup(f) {
  if (process.env.COEDIT_SIGNAL_EVIDENCE) {
    fs.mkdirSync(process.env.COEDIT_SIGNAL_EVIDENCE, { recursive: true });
    fs.cpSync(f.dir, path.join(process.env.COEDIT_SIGNAL_EVIDENCE, f.label), { recursive: true });
  }
  fs.rmSync(f.dir, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: f.label, removed: !fs.existsSync(f.dir), allChildrenAwaited: true }));
}
async function recoveryCase(label, inject, blocked) {
  const f = fixture(label);
  let h;
  try {
    const origin = await originChild(f.root, f.priv, f.recovery);
    const names = fs.readdirSync(f.priv);
    const txnName = names.find((n) => n.endsWith('.txn'));
    const outName = names.find((n) => n.endsWith('.out'));
    assert.ok(txnName && outName, 'real immutable transaction/outcome required');
    const txnBytes = fs.readFileSync(path.join(f.priv, txnName));
    const outBytes = fs.readFileSync(path.join(f.priv, outName));
    const txn = JSON.parse(txnBytes);
    assert.equal(txn.pid, origin.originPid, 'actual gone-origin identity, never fabricated');
    h = connect(f.root, f.priv, blocked);
    assert.equal((await h.call({ op: 'hello', recovery: f.recovery })).protocol, 3);
    const disposal = { op: 'dispose', path: 'a.md', entry: origin.published.displaced, hash: sha('a') };
    if (inject) disposal.fault = 'sigioAfterDelivery';
    const reply = await h.call(disposal);
    const exit = await h.finish();
    h = null;
    console.log(JSON.stringify({ phase: "disposal-observation", label, reply, exit }));
    const retained = path.join(f.priv, origin.published.displaced);
    const doneNames = fs.readdirSync(f.priv).filter((n) => n.endsWith('.done'));
    assert.equal(doneNames.length, 1);
    const doneBytes = fs.readFileSync(path.join(f.priv, doneNames[0]));
    const done = JSON.parse(doneBytes);
    assert.equal(done.hash, sha('aQ'));
    assert.equal(fs.readFileSync(done.path, 'utf8'), 'aQ');
    assert.equal(fs.readFileSync(path.join(f.root, 'a.md'), 'utf8'), 'Pa');
    assert.deepEqual(fs.readFileSync(path.join(f.priv, txnName)), txnBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.priv, outName)), outBytes);
    const result = { label, inject, blocked, origin, reply, exit, retainedExists: fs.existsSync(retained),
      retainedHash: fs.existsSync(retained) ? sha(fs.readFileSync(retained)) : null,
      copyHash: sha(fs.readFileSync(done.path)), txnHash: sha(txnBytes), outHash: sha(outBytes), doneHash: sha(doneBytes), done };
    console.log(JSON.stringify(result));
    if (inject) {
      // Intentionally FIRST: the inverse baseline must fail exact retained-byte survival, not a setup exception.
      assert.deepEqual(fs.existsSync(retained) ? fs.readFileSync(retained) : null, Buffer.from('aQ'), 'exact retained aQ must survive self-SIGIO');
      assert.equal(reply, null, 'termination must not send a successful or other disposal reply');
      assert.equal(exit.code, null);
      assert.ok(['SIGIO', 'SIGPOLL'].includes(exit.signal));
    } else {
      assert.equal(fs.existsSync(retained), false);
      assert.deepEqual(reply, { ok: false, owned: true, recovered: true, id: 2 });
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
    }
  } finally {
    if (h) await h.finish();
    cleanup(f);
  }
}
if (process.argv[2] === '--origin') {
  const result = await originate(...process.argv.slice(3));
  console.log(JSON.stringify(result));
} else {
  test('self-signal after verified delivery retains exact bytes', () => recoveryCase('self-signal', true, false));
  test('inherited blocked SIGIO is explicitly unblocked', () => recoveryCase('inherited-blocked', true, true));
  test('no-injection genuine recovery completes normally', () => recoveryCase('recovery-control', false, false));
  test('valid ordinary disposal completes without injected signal', async () => {
    const f = fixture('normal-dispose');
    const h = connect(f.root, f.priv);
    try {
      assert.equal((await h.call({ op: 'hello', recovery: f.recovery })).protocol, 3);
      const r = await h.call({ op: 'read', path: 'a.md' });
      const p = await h.call({ op: 'publish', path: 'a.md', ino: r.ino, dev: r.dev, hash: r.hash,
        data: Buffer.from('Pa').toString('base64'), txn: 'b0b0b0', token: 'synthetic-normal-token' });
      assert.equal(p.ok, true);
      assert.equal((await h.call({ op: 'dispose', path: 'a.md', entry: p.displaced, hash: r.hash })).ok, true);
      assert.equal(fs.existsSync(path.join(f.priv, p.displaced)), false);
      assert.equal(fs.readFileSync(path.join(f.root, 'a.md'), 'utf8'), 'Pa');
    } finally {
      const exit = await h.finish();
      assert.equal(exit.code, 0);
      assert.equal(exit.signal, null);
      cleanup(f);
    }
  });
}
