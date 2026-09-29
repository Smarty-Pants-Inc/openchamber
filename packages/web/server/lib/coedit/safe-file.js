import { spawn } from 'child_process';
import net from 'net';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
/** A file name's limit in bytes (Linux NAME_MAX): a recovery name must fit, however long the file's name (#37 item 3). */
const NAME_MAX = 255;
/** `name` cut to at most `max` UTF-8 bytes, keeping its end (the extension) and never splitting a character. */
const fitName = (name, max) => {
  let out = name;
  while (Buffer.byteLength(out) > max) out = Array.from(out).slice(1).join('');
  return out;
};
/** The helper protocol this module speaks: a helper that answers `hello` otherwise is refused (#37 item 5). */
export const PROTOCOL = 3;
/** The helper's limit (fs-helper MAX_BYTES): refused before any copy or call. */
const MAX_BYTES = 64 << 20;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);
/** The coedit-fs helper (smartyfs#32): OPENCHAMBER_COEDIT_FS, or the one built beside this file. */
export const helperPath = () =>
  process.env.OPENCHAMBER_COEDIT_FS || path.join(import.meta.dirname, 'fs-helper/target/release/coedit-fs');
/**
 * The coedit-fs service's socket (smartyfs#32): the helper runs as its own account (`smarty-coedit`), started by systemd
 * per connection, so no program running as the account it serves can reach its private directory.
 */
export const helperSocket = () => process.env.OPENCHAMBER_COEDIT_SOCKET || '';
/** Tests and development only: run the helper as this account (the pre-#32 residual), never by default. */
const sameAccountAllowed = () => process.env.OPENCHAMBER_COEDIT_SAME_ACCOUNT === '1';
/** Co-editing writes only through the helper's atomic Linux calls. Elsewhere, or without it, it fails closed. */
export const anchoredFilesAvailable = () => process.platform === 'linux' && (helperSocket() ? fs.existsSync(helperSocket()) : fs.existsSync(helperPath()));

/** Shown with a conflict whose save may have displaced another writer's revision (org's condition on smartyfs#32). */
export const DISTURBED_NOTICE = 'Another writer changed this file during your save: check the recovery folder.';
/** Shown when a save may or may not have reached the disk: the room holds until the disk says which. */
export const UNCERTAIN_NOTICE = 'This save could not be confirmed: the previous version is in the recovery folder.';
/** Shown while a published save is not yet durable (a directory flush failed): it is confirmed once a flush succeeds. */
export const UNSYNCED_NOTICE = 'This save is on disk but not yet flushed: the previous version is in the recovery folder.';

/**
 * The helper's name prefix for a file's private entries: the first 16 hex characters of sha256(root NUL rel). The root
 * is in it, so two projects sharing a recovery directory never collect each other's entries (smartyfs#34 item 14).
 */
export const keyOf = (root, rel) => hashBytes(Buffer.from(`${root}\0${rel}`, 'utf8')).slice(0, 16);

const TEST_HOOKS = new Set(['pause', 'pauseMs', 'fault', 'testOwners', 'testGroupMembers']);
/**
 * Tests only: the helper's named pauses and faults from `hooks.helper`, and nothing else. They go FIRST in a request,
 * so they can never replace its fields (item 15); a helper honours them only if started with `testHooks` (item 12).
 */
export const testHooks = (hooks) => Object.fromEntries(Object.entries(hooks?.helper ?? {}).filter(([k]) => TEST_HOOKS.has(k)));

function syncDirectorySync(dir) {
  const fd = fs.openSync(dir, O_RDONLY | O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Creates `dir` and its missing ancestors (0700), then names every ancestor of ours durably in its parent. Every start
 * does this, so a tree left by an earlier start whose flush failed is flushed again; a failed flush throws.
 */
function makeDirDurable(dir) {
  const missing = [];
  for (let d = dir; !fs.existsSync(d) && path.dirname(d) !== d; d = path.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    try {
      fs.mkdirSync(d, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  for (let d = dir; path.dirname(d) !== d && fs.lstatSync(d).uid === process.geteuid(); d = path.dirname(d)) {
    syncDirectorySync(path.dirname(d));
  }
}

/**
 * The helper's private dir, `<recoveryDir>/.staging`: the recovery directory must be ours and not writable by others;
 * `.staging` is opened without following a link and made 0700 through that descriptor, so no chmod reaches elsewhere.
 */
/** The recovery directory (the bridge's, as this account): created durably; ours, not a link, not writable by others. */
function prepareRecoveryDir(recoveryDir) {
  makeDirDurable(recoveryDir);
  const st = fs.lstatSync(recoveryDir);
  if (!st.isDirectory() || st.uid !== process.geteuid() || (st.mode & 0o022) !== 0) {
    throw new Error('Co-editing needs a recovery directory of its own, not a link or one others can write to');
  }
}

function preparePrivateDir(privateDir) {
  const recoveryDir = path.dirname(privateDir);
  prepareRecoveryDir(recoveryDir);
  try {
    fs.mkdirSync(privateDir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let fd;
  try {
    fd = fs.openSync(privateDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new Error('Co-editing refuses a staging directory that is a link or not a directory');
    throw error;
  }
  try {
    if (fs.fstatSync(fd).uid !== process.geteuid()) throw new Error('Co-editing refuses a staging directory it does not own');
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectorySync(recoveryDir);
}

/**
 * One coedit-fs process for a project root, with `privateDir` (0700, ours) for its staging and displaced revisions.
 * A bad or truncated reply line, or a call past its deadline (`timeoutMs`), ends the helper: SIGKILL, and every waiting
 * call rejects. `close()` resolves once the process has exited. The helper honours test pauses and faults only when
 * `testHooks` is set: COEDIT_FS_TEST is removed from its environment otherwise.
 */
export function startHelper(root, privateDir, { timeoutMs = 30_000, testHooks: forTests = false } = {}) {
  if (!anchoredFilesAvailable()) throw new Error('Co-editing needs the coedit-fs helper, which this system lacks');
  const socket = helperSocket();
  if (socket) {
    prepareRecoveryDir(path.dirname(privateDir)); // The service keeps its own staging; recovery copies stay ours.
    return connectHelper(socket, root, { timeoutMs });
  }
  if (!forTests && !sameAccountAllowed()) {
    throw new Error('Co-editing needs the coedit-fs service (OPENCHAMBER_COEDIT_SOCKET): the helper must not run as this account');
  }
  preparePrivateDir(privateDir);
  const env = { ...process.env };
  delete env.COEDIT_FS_TEST;
  if (forTests) env.COEDIT_FS_TEST = '1';
  const child = spawn(helperPath(), ['--same-account', root, privateDir], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  return speak(child.stdin, child.stdout, {
    timeoutMs,
    pid: child.pid,
    root: null,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
    onEnd: (end, markExited) => {
      child.on('error', (error) => {
        if (child.pid === undefined) markExited(); // Never started: there is no exit to wait for.
        end(error);
      });
      child.on('exit', (code, signal) => {
        markExited();
        end(new Error(`coedit-fs ended (${signal ?? code})`));
      });
      child.stdin.on('error', end);
    },
  });
}

/**
 * A connection to the coedit-fs service: systemd starts one helper, as its own account, per connection; the root goes
 * in the first request. Ending the connection ends that helper (it reads EOF); it cannot be killed from this account.
 */
function connectHelper(socketPath, root, { timeoutMs }) {
  const conn = net.createConnection(socketPath);
  return speak(conn, conn, {
    timeoutMs,
    pid: undefined,
    root,
    // Closing half-closes: the service helper reads EOF after its current operation and exits; a hung one is cut
    // after 5 s. Neither proves the other account's process has stopped: the helper's per-file lock and its
    // connection check do (#412 finding 3), so a later recovery of that file waits for, or never races, it.
    kill: () => {
      conn.end();
      setTimeout(() => conn.destroy(), 5000).unref();
    },
    onEnd: (end, markExited) => {
      conn.on('error', (error) => end(new Error(`coedit-fs connection failed (${error.message})`)));
      conn.on('close', () => {
        markExited();
        end(new Error('coedit-fs ended (connection closed)'));
      });
    },
  });
}

/** The JSON-lines protocol over a helper's input and output, with deadlines, a frame guard and the handshake. */
function speak(input, output, { timeoutMs, pid, root, kill, onEnd }) {
  const waiting = new Map();
  let next = 0;
  let ended = null;
  let markExited;
  const exited = new Promise((done) => { markExited = done; });
  const end = (error) => {
    ended ??= error;
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(ended);
    }
    waiting.clear();
    kill();
  };
  onEnd(end, markExited);
  const lines = createInterface({ input: output });
  // readline re-emits its input's errors; the connection's own error handler already ends the helper.
  lines.on('error', () => {});
  lines.on('line', (line) => {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      end(new Error('coedit-fs sent a bad reply'));
      return;
    }
    const entry = waiting.get(reply?.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(reply.id);
    entry.resolve(reply);
  });
  const send = (request) => new Promise((resolve, reject) => {
    if (ended) return reject(ended);
    const id = ++next;
    const timer = setTimeout(() => end(new Error('coedit-fs did not answer in time')), timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    // A failed write ends the helper through its error handler; the callback only keeps it from being unhandled.
    input.write(`${JSON.stringify({ ...request, id })}\n`, () => {});
  });
  // Every request waits for the handshake: a helper of another protocol (an older build) ends before any request.
  const ready = send(root ? { op: 'hello', root } : { op: 'hello' }).then((reply) => {
    if (reply.ok && reply.protocol === PROTOCOL) return;
    const error = new Error(reply.ok || /unknown op/.test(String(reply.error))
      ? `coedit-fs speaks protocol ${reply.protocol ?? 'unknown'}, not ${PROTOCOL}`
      : `coedit-fs refused the project root: ${reply.error}`);
    end(error);
    throw error;
  });
  ready.catch(() => {}); // Each call reports it.
  return {
    pid,
    /** Whether a request sent now can still reach the helper. */
    alive: () => ended === null,
    call: (request) => ready.then(() => send(request)),
    close: () => {
      end(new Error('coedit-fs closed'));
      return exited;
    },
  };
}

const refused = (reply) => {
  const error = String(reply.error);
  // openat2 refuses a link anywhere in the path (ELOOP) and a path that leaves the root (EXDEV).
  if (/symbolic links|cross-device|left the project/i.test(error)) return new Error(`Co-edited file left its project or is a link (${error})`);
  if (/not a regular file/.test(error)) return new Error('Co-edited file is not a regular file');
  return new Error(`Co-edited file: ${error}`);
};

/** The bytes of `rel` (under the root) with their identity, or null when missing. */
export async function readFile(helper, rel) {
  const reply = await helper.call({ op: 'read', path: rel });
  if (reply.conflict === 'gone') return null;
  if (!reply.ok) throw refused(reply);
  const bytes = Buffer.from(reply.data, 'base64');
  return { bytes, hash: reply.hash, ino: reply.ino, dev: reply.dev };
}

export const decode = (bytes) => {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error('Co-edited file is not UTF-8 text');
  }
};

/**
 * A settled revision of `rel` (or null when missing): the same content and identity in two reads `settleMs` apart,
 * so a writer mid-write is waited out. ponytail: a writer that pauses longer is seen as a revision; its next write
 * arrives as the next one. This only feeds the room's display; the disk is never written from it.
 */
export async function readSettled(helper, rel, settleMs) {
  const same = (a, b) => (a === null ? b === null : b !== null && a.hash === b.hash && a.ino === b.ino);
  let previous = await readFile(helper, rel);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((done) => setTimeout(done, settleMs));
    const current = await readFile(helper, rel);
    if (same(previous, current)) return current === null ? null : { text: decode(current.bytes), hash: current.hash };
    previous = current;
  }
  throw new Error('Co-edited file keeps changing');
}

/**
 * Keeps `bytes` in the recovery directory under a new name (never replacing one); returns its path. The name is
 * `<time>-<random>-<key>-[ours-]<file name>`: `key` ties it to its file for retention (pruneRecovery), and `kind`
 * marks the copy (`ours`: a revision we published; otherwise one we replaced).
 */
export async function keepForRecovery(recoveryDir, name, bytes, { key, kind = '' }) {
  const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}-${key}-${kind ? `${kind}-` : ''}`;
  const kept = path.join(recoveryDir, `${prefix}${fitName(name, NAME_MAX - Buffer.byteLength(prefix))}`);
  const handle = await fs.promises.open(kept, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(recoveryDir); // The entry itself is durable, not only its bytes.
  return kept;
}

/** A recovery copy's name as keepForRecovery writes it: its time and its file's key. */
const RECOVERY_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}-([0-9a-f]{16})-/;
export const RETENTION = { days: 7, newest: 20 };

/**
 * Retention (smartyfs#37, org's decision 2026-09-29): a recovery copy of the file `key` is deleted only when it is
 * older than 7 days AND not among that file's newest 20. Only regular files whose names keepForRecovery wrote for this
 * key, owned by this account, are considered; anything else in the directory is never touched. Returns the count.
 */
export async function pruneRecovery(recoveryDir, key, { now = Date.now(), days = RETENTION.days, newest = RETENTION.newest } = {}) {
  const copies = [];
  for (const entry of await fs.promises.readdir(recoveryDir, { withFileTypes: true })) {
    const m = RECOVERY_NAME.exec(entry.name);
    if (!m || m[6] !== key || !entry.isFile()) continue;
    const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    if (Number.isFinite(at)) copies.push({ name: entry.name, at });
  }
  copies.sort((a, b) => b.at - a.at);
  let removed = 0;
  for (const { name, at } of copies.slice(newest)) {
    if (now - at <= days * 86_400_000) continue;
    const full = path.join(recoveryDir, name);
    const st = await fs.promises.lstat(full).catch(() => null);
    if (!st?.isFile() || st.uid !== process.geteuid()) continue;
    await fs.promises.unlink(full);
    removed += 1;
  }
  if (removed) await syncDirectory(recoveryDir);
  return removed;
}

async function syncDirectory(dir) {
  const handle = await fs.promises.open(dir, O_RDONLY | O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Removes a private entry (`{ entry, hash }`) once no process has it open for writing. Bytes written through an old
 * descriptor meanwhile are kept for recovery first: `late` is that copy, and `hash` the bytes it now holds.
 * `busy: true`: a writer still has it open; it stays, and is tried again later. `unsynced: true`: removed, but the
 * private dir's flush failed.
 */
export async function dispose(helper, key, revision, recoveryDir, rel, hooks = {}) {
  const name = path.basename(rel);
  let { hash } = revision;
  let late;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reply = await helper.call({ ...testHooks(hooks), op: 'dispose', path: rel, entry: revision.entry, hash });
    if (reply.ok) return reply.synced === false ? { late, hash, unsynced: true } : { late, hash };
    if (reply.busy) return { busy: true, late, hash };
    if (!reply.changed) throw refused(reply);
    late = await keepForRecovery(recoveryDir, name, Buffer.from(reply.data, 'base64'), { key });
    hash = reply.hash;
  }
  return { busy: true, late, hash };
}

/**
 * Publishes `text` as `rel` only over the revision whose hash is `expectedHash`. One attempt, never undone:
 *  - the current bytes must still hash to `expectedHash`, else { conflict: 'changed' } ('gone' when missing): no write;
 *  - those bytes are kept for recovery first, and ours too (`-ours-`), removed again if the helper refuses;
 *  - the helper stages ours in the private dir and publishes with one exchange (DOCUMENTATION.md, protocol);
 *  - the displaced revision (now a private entry) is removed only when no one writes to it; a late write through an
 *    old descriptor is kept and shown ('raced'). `pending`: still open for writing, retried later.
 * Returns { ok: true, recovery, pending? }, { conflict } (not published), { conflict: 'raced', published: true, ... },
 * or { conflict: 'unverified', published: 'uncertain', ... } when the helper cannot prove what was published, or its
 * reply was lost after the request was sent.
 * `unsynced: true`: a flush after the exchange failed (or may have). The save is not durable until a `flush` succeeds;
 * the displaced revision is not disposed meanwhile (it comes back as `pending`), and a published save that is
 * otherwise proven is { conflict: 'unverified', published: true, unsynced: true }.
 */
export async function publish(helper, rel, text, expectedHash, { recoveryDir, key, hooks = {} }) {
  const name = path.basename(rel);
  const current = await readFile(helper, rel);
  if (current === null) return { conflict: 'gone' };
  if (current.hash !== expectedHash) return { conflict: 'changed' };
  const recovery = await keepForRecovery(recoveryDir, name, current.bytes, { key });
  // Ours too, BEFORE the helper call: a writer that read before this save may replace the file after it, and a crash
  // of the room would then lose our revision (the smartyfs#32 stress test, seed 32). Before the call, a failed copy
  // throws with nothing sent; after it, nothing may throw (#396 review round 3). A refused save removes the copy.
  const data = Buffer.from(text, 'utf8');
  if (data.length > MAX_BYTES) throw new Error('Co-edited file is too large');
  if (!helper.alive()) throw new Error('coedit-fs is not running');
  const ours = await keepForRecovery(recoveryDir, name, data, { key, kind: 'ours' });
  const dropOurs = () => fs.promises.unlink(ours).catch((error) => log('smarty.coedit-recovery-cleanup-failed', name, error));
  const txn = randomBytes(6).toString('hex');
  const uncertain = { conflict: 'unverified', published: 'uncertain', recovery, notice: UNCERTAIN_NOTICE };
  let reply;
  try {
    reply = await helper.call({
      ...testHooks(hooks),
      op: 'publish', path: rel, key, txn, ino: current.ino, dev: current.dev, hash: expectedHash, data: data.toString('base64'),
    });
  } catch (error) {
    log('smarty.coedit-publish-uncertain', name, error);
    return { ...uncertain, unsynced: true, lost: txn }; // Sent, no reply: published or not, flushed or not.
  }
  if (reply.published !== true) {
    await dropOurs(); // Not published: ours was never on disk, and the room still holds it.
    if (reply.conflict) return { conflict: reply.conflict, recovery };
    throw refused(reply);
  }
  // Published: from here on, nothing may be reported as not written, and nothing below may throw.
  const synced = reply.synced === true;
  // Not durable: the displaced revision stays until a flush succeeds (the caller holds it as pending).
  let done = { busy: true, hash: expectedHash };
  if (synced) {
    try {
      done = await dispose(helper, key, { entry: reply.displaced, hash: expectedHash }, recoveryDir, rel, hooks);
    } catch (error) {
      log('smarty.coedit-dispose-failed', name, error);
    }
  }
  const unsynced = !synced || done.unsynced === true;
  let result = { ok: true, recovery };
  // The exchange is certain (the helper replied). A writer that replaced ours, or wrote into it, right after is an
  // outside write to a published file, shown as raced: the base follows ours, so the next sync never replays it.
  // Only an observation or relocation that cannot be read holds the room.
  const outside = reply.uncertain === 'replaced' || reply.uncertain === 'bytes';
  if (reply.uncertain && !outside) result = { ...uncertain };
  else if (outside || done.late || reply.conflict === 'raced') result = { conflict: 'raced', published: true, recovery: done.late ?? recovery, notice: DISTURBED_NOTICE };
  else if (unsynced) result = { conflict: 'unverified', published: true, recovery, notice: UNSYNCED_NOTICE };
  if (unsynced) result.unsynced = true;
  if (done.busy) result.pending = { entry: reply.displaced, hash: done.hash };
  return result;
}

const log = (type, file, error) => console.error(JSON.stringify({ type, file, error: String(error?.message ?? error) }));

/**
 * Finishes saves of `rel` that a crash or a lost helper interrupted: each private entry for its key is kept for
 * recovery and disposed. Returns the recovery copies, the entries still open for writing (`pending`), and late copies.
 * `durable: false` (the file's flush failed): each is kept for recovery but not disposed; all come back as `pending`.
 * `unsynced`: a disposal's flush failed.
 */
export async function finishInterruptedSaves(helper, key, rel, recoveryDir, { durable = true, hooks = {} } = {}) {
  const name = path.basename(rel);
  const reply = await helper.call({ op: 'list', path: rel });
  if (!reply.ok) throw refused(reply);
  const finished = [];
  const pending = [];
  const late = [];
  let unsynced = false;
  for (const { entry, hash, data } of reply.entries) {
    finished.push(await keepForRecovery(recoveryDir, name, Buffer.from(data, 'base64'), { key }));
    if (!durable) {
      pending.push({ entry, hash });
      continue;
    }
    const done = await dispose(helper, key, { entry, hash }, recoveryDir, rel, hooks);
    if (done.late) late.push(done.late);
    if (done.busy) pending.push({ entry, hash: done.hash });
    if (done.unsynced) unsynced = true;
  }
  return { finished, pending, late, unsynced };
}
