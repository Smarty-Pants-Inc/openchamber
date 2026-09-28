import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
const PROC_FD = '/proc/self/fd';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);
/** Co-editing writes only where the kernel anchors paths to a held directory (Linux). Elsewhere it fails closed. */
export const anchoredFilesAvailable = () => fs.existsSync(PROC_FD);

/**
 * The directory of a co-edited file, opened from the project root one component at a time with O_NOFOLLOW and held by
 * its fd. Every operation goes through /proc/self/fd/<fd>/<name>, so a directory swapped for a link cannot redirect
 * it. `verify()` reads where the held directory is now and throws unless it is still inside the root.
 */
export async function openParent(root, file) {
  if (!anchoredFilesAvailable()) throw new Error('Co-editing needs anchored file access, which this system lacks');
  const dir = path.dirname(file);
  if (!inside(root, dir)) throw new Error('Co-edited file left its project');
  let handle = await fs.promises.open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
      const next = await fs.promises.open(`${PROC_FD}/${handle.fd}/${part}`, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        .catch((error) => {
          throw error.code === 'ELOOP' || error.code === 'ENOTDIR' ? new Error('Co-edited file left its project') : error;
        });
      await handle.close();
      handle = next;
    }
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  const parent = {
    at: (name) => `${PROC_FD}/${handle.fd}/${name}`,
    async verify() {
      const now = await fs.promises.readlink(`${PROC_FD}/${handle.fd}`).catch(() => '');
      if (!inside(root, now)) throw new Error('Co-edited file left its project');
    },
    sync: () => handle.sync(), // Errors reach the caller: a publish that may not be durable is not reported ok.
    close: () => handle.close().catch(() => {}),
  };
  await parent.verify();
  return parent;
}

/** The bytes of `name` through an fd opened without following links, or null when it is missing. */
export async function openFile(parent, name) {
  const handle = await fs.promises.open(parent.at(name), O_RDONLY | O_NOFOLLOW).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error.code === 'ELOOP' ? new Error('Co-edited file is a link') : error;
  });
  if (handle === null) return null;
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw new Error('Co-edited file is not a regular file');
  }
  const bytes = await handle.readFile();
  return { handle, stat, bytes, hash: hashBytes(bytes) };
}

export const decode = (bytes) => {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error('Co-edited file is not UTF-8 text');
  }
};

/**
 * A settled revision of `name` (or null when missing): the same content and identity in two reads `settleMs` apart,
 * so a writer mid-write is waited out. ponytail: a writer that pauses longer is seen as a revision; its next write
 * arrives as the next one. This only feeds the room's display; the disk is never written from it.
 */
export async function readSettled(parent, name, settleMs) {
  const look = async () => {
    const found = await openFile(parent, name);
    if (found) await found.handle.close();
    return found;
  };
  const same = (a, b) => (a === null ? b === null : b !== null && a.hash === b.hash && a.stat.ino === b.stat.ino);
  let previous = await look();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(settleMs);
    const current = await look();
    if (same(previous, current)) return current === null ? null : { text: decode(current.bytes), hash: current.hash };
    previous = current;
  }
  throw new Error('Co-edited file keeps changing');
}

/** Keeps `bytes` in the recovery directory under a new name (never replacing one); returns its path. */
export async function keepForRecovery(recoveryDir, name, bytes) {
  if (!fs.existsSync(recoveryDir)) {
    await fs.promises.mkdir(recoveryDir, { recursive: true, mode: 0o700 });
    await syncDirectory(path.dirname(recoveryDir)); // The new directory's entry is durable too.
  }
  const kept = path.join(recoveryDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}-${name}`);
  const handle = await fs.promises.open(kept, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const dir = await fs.promises.open(recoveryDir, O_RDONLY | O_DIRECTORY);
  try {
    await dir.sync(); // The entry itself is durable, not only its bytes.
  } finally {
    await dir.close();
  }
  return kept;
}

/**
 * Publishes `text` as `name` only over the revision whose hash is `expectedHash`. One attempt:
 *  - the current bytes must still hash to `expectedHash`, else { conflict: 'changed' } ('gone' when missing): no write;
 *  - those bytes are kept for recovery first, so nothing displaced is ever lost;
 *  - the staging file is ours alone (created O_EXCL, its inode checked with nlink 1 right before the rename);
 *  - after the rename the file must be that staging inode, and the replaced revision must be unchanged, else a conflict
 *    whose bytes are kept too. Any doubt is a conflict for the person to see, never a silent success.
 * Returns { ok: true } or { conflict, recovery? }.
 */
/** Shown with a conflict whose save may have displaced another writer's revision (org's condition on smartyfs#32). */
export const DISTURBED_NOTICE = 'Another writer changed this file during your save: check the recovery folder.';

export async function publish(parent, name, text, expectedHash, { recoveryDir, target, hooks = {} }) {
  await parent.verify();
  const current = await openFile(parent, name);
  if (current === null) return { conflict: 'gone' };
  // The staging file lives in a private 0700 directory, held by its fd, and is published FROM that fd (security pass
  // round 6, item 1): another account that can write the project can rename or replace the directory's name, but not
  // what is inside it, and the rename's source is resolved through our fd, not by name. ponytail: a process of the
  // same account can still reach inside it (the accepted same-uid limit, smarty-dev#820); if it does, the check after
  // the rename finds a foreign file and the result says so, so the room's base does not follow it.
  const state = { current, dirName: `.coedit-${process.pid}-${randomBytes(6).toString('hex')}`, dir: null, dirStat: null,
    staging: null, ours: null, published: false, marker: null, uncertain: false };
  let result;
  let failure = null;
  try {
    result = await attempt(parent, name, text, expectedHash, { recoveryDir, target, hooks }, state);
  } catch (error) {
    failure = error;
  }
  const errors = await release(parent, state, name, hooks);
  if (errors.length && state.published) {
    // A release that failed after the rename (a close's I/O error) must not lose the committed result (round 6,
    // item 2): the publication is reported, uncertain, and its marker stays for the next load.
    console.error(JSON.stringify({ type: 'smarty.coedit-publish-uncertain', file: name, error: errors.map(String).join('; ') }));
    const { ok, ...rest } = result ?? {};
    return { ...rest, conflict: result?.conflict ?? 'unverified', published: true, notice: DISTURBED_NOTICE };
  }
  if (failure) throw failure;
  return result;
}

async function attempt(parent, name, text, expectedHash, { recoveryDir, target, hooks }, state) {
  const { current } = state;
  const intended = Buffer.from(text, 'utf8');
  if (current.hash !== expectedHash) return { conflict: 'changed' };
  const recovery = await keepForRecovery(recoveryDir, name, current.bytes);
  await parent.verify();
  await fs.promises.mkdir(parent.at(state.dirName), { mode: 0o700 });
  state.dir = await fs.promises.open(parent.at(state.dirName), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  state.dirStat = await state.dir.stat();
  if ((state.dirStat.mode & 0o077) !== 0 || state.dirStat.uid !== process.getuid()) return { conflict: 'unverified', recovery };
  const staging = `${PROC_FD}/${state.dir.fd}/${name}`;
  state.staging = await fs.promises.open(staging, fs.constants.O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, current.stat.mode & 0o7777);
  const ours = (state.ours = await state.staging.stat());
  // A crash from here on leaves this marker (its own directory); the next load finishes the save by inode.
  state.marker = await writeMarker(recoveryDir, { target, staging: `${state.dirName}/${name}`, dev: ours.dev, ino: ours.ino, recovery, at: Date.now() });
  await state.staging.writeFile(intended);
  await state.staging.chmod(current.stat.mode & 0o7777); // The creation mode passes through the umask; this does not.
  await state.staging.sync();
  await hooks.beforePublish?.({ staging, entry: parent.at(state.dirName) });
  // What will be published is exactly what we wrote: read back through our own fd (net-lead round 4).
  const written = await readWhole(state.staging, (await state.staging.stat()).size);
  if (hashBytes(written) !== hashBytes(intended)) return { conflict: 'unverified', recovery };
  await parent.verify();
  const named = await fs.promises.lstat(staging).catch(() => null);
  const again = await openFile(parent, name);
  if (again) await again.handle.close();
  if (!named || named.ino !== ours.ino || named.dev !== ours.dev || named.nlink !== 1) return { conflict: 'unverified', recovery };
  if (again && (again.stat.ino !== current.stat.ino || again.hash !== expectedHash)) return { conflict: 'changed', recovery };
  // Deleted after the check (no file, or our revision's last name gone): the rename would bring it back.
  if (!again || (await current.handle.stat()).nlink === 0) return { conflict: 'gone', recovery };
  await hooks.beforeRename?.({ staging, entry: parent.at(state.dirName) });
  await fs.promises.rename(staging, parent.at(name));
  state.published = true; // Recorded before anything that can throw (security pass round 5, item B).
  // What the rename installed, looked at first thing: our inode means our verified bytes were published, even if an
  // outside writer replaces the file right after (then the base must still follow ours, or the next sync would replay
  // the edit: round 7). Anything else was substituted before the rename (same account only): `foreign`.
  const installed = await fs.promises.lstat(parent.at(name)).catch(() => null);
  const oursInstalled = Boolean(installed && installed.ino === ours.ino && installed.dev === ours.dev);
  if (!oursInstalled) {
    return { conflict: 'unverified', published: true, foreign: true, recovery, notice: DISTURBED_NOTICE };
  }
  // Everything after the rename is reported as committed (`published`), never thrown: an exception here (a failed
  // directory fsync, a failed recovery read) is an uncertain publication, and the room's base must still follow
  // what was written, or the next sync would replay the person's edit.
  try {
    await hooks.afterRename?.();
    await parent.sync();
    // ponytail: a held directory moved outside the project between the last check and the rename is only detected
    // here, after the fact (an fd pins no location; true confinement needs a mount namespace). It is reported as a
    // conflict and logged for an alert; the accepted limit is recorded in DOCUMENTATION.md.
    try {
      await parent.verify();
    } catch {
      console.error(JSON.stringify({ type: 'smarty.coedit-escaped', file: name }));
      return { conflict: 'escaped', published: true, recovery, notice: DISTURBED_NOTICE };
    }
    await hooks.afterPublish?.();
    // What is published is exactly our bytes (security pass round 5, item A): the file at the path is still our
    // inode, and its content, read through our own held fd, hashes to what we meant to write. Replaced since the
    // rename: our bytes were published, then another writer changed the file (a conflict; the base follows ours).
    const now = await fs.promises.lstat(parent.at(name)).catch(() => null);
    if (!now || now.ino !== ours.ino || now.dev !== ours.dev) return { conflict: 'unverified', published: true, recovery, notice: DISTURBED_NOTICE };
    const content = await readWhole(state.staging, (await state.staging.stat()).size);
    if (hashBytes(content) !== hashBytes(intended)) return { conflict: 'unverified', published: true, recovery, notice: DISTURBED_NOTICE };
    // The replaced revision, reread whole through the fd held since the check: a write made through an old fd
    // meanwhile is kept for recovery, and shown.
    const whole = await readWhole(current.handle, (await current.handle.stat()).size);
    if (hashBytes(whole) !== expectedHash) {
      return { conflict: 'raced', published: true, recovery: await keepForRecovery(recoveryDir, name, whole), notice: DISTURBED_NOTICE };
    }
    return { ok: true, recovery };
  } catch (error) {
    state.uncertain = true; // Its marker stays, so the next load reports the interrupted save too.
    console.error(JSON.stringify({ type: 'smarty.coedit-publish-uncertain', file: name, error: String(error?.message ?? error) }));
    return { conflict: 'unverified', published: true, recovery, notice: DISTURBED_NOTICE };
  }
}

/** Releases what a publish held, each step on its own (one failing never skips the others); returns their errors. */
async function release(parent, state, name, hooks) {
  const errors = [];
  const step = async (fn) => { try { await fn(); } catch (error) { errors.push(error); } };
  const close = (label, handle) => step(async () => {
    if (!handle) return;
    await handle.close();
    await hooks.afterClose?.(label); // Tests only: a close that reports an I/O error.
  });
  await close('staging', state.staging);
  await close('current', state.current.handle);
  if (state.dir) {
    // Only our own staging inode is removed (none is left once published), then our directory, if it still has its
    // name and is empty; a name that now points elsewhere is left alone.
    if (!state.published && state.ours) {
      await step(async () => {
        const staging = `${PROC_FD}/${state.dir.fd}/${name}`;
        const named = await fs.promises.lstat(staging).catch(() => null);
        if (named && named.ino === state.ours.ino && named.dev === state.ours.dev) await fs.promises.unlink(staging);
      });
    }
    await step(async () => {
      const named = await fs.promises.lstat(parent.at(state.dirName)).catch(() => null);
      if (named && named.ino === state.dirStat?.ino && named.dev === state.dirStat?.dev) await fs.promises.rmdir(parent.at(state.dirName)).catch(() => {});
    });
    await step(() => state.dir.close());
  }
  // Finished and certain: nothing left to finish. An uncertain or failed-release publication keeps its marker.
  if (state.marker && !state.uncertain && !(errors.length && state.published)) await fs.promises.unlink(state.marker).catch(() => {});
  return errors;
}

async function readWhole(handle, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

/** Pending-save markers live in their own 0700 directory, never among the recovery copies (net-lead round 4). */
const markerDir = (recoveryDir) => path.join(recoveryDir, '.pending');

async function syncDirectory(dir) {
  const handle = await fs.promises.open(dir, O_RDONLY | O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeMarker(recoveryDir, value) {
  const dir = markerDir(recoveryDir);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${randomBytes(8).toString('hex')}.json`);
  const handle = await fs.promises.open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dir);
  return file;
}

/**
 * Finishes saves of `target` that a crash interrupted (their markers): the staging file left in the project is removed
 * only if it is still the very inode the save created; the recovery copy is kept; the marker cleared. A malformed marker
 * is logged and kept for a person. Returns the recovery copies of the interrupted saves, for a notice.
 */
export async function finishInterruptedSaves(parent, recoveryDir, target) {
  const dir = markerDir(recoveryDir);
  const names = await fs.promises.readdir(dir).catch(() => []);
  const finished = [];
  for (const entry of names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n))) {
    const file = path.join(dir, entry);
    const marker = await fs.promises.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (!marker || !Number.isSafeInteger(marker.ino) || !Number.isSafeInteger(marker.dev) || !marker.recovery) {
      console.error(JSON.stringify({ type: 'smarty.coedit-marker-malformed', marker: file }));
      continue;
    }
    if (marker.target !== target) continue;
    const staging = String(marker.staging);
    // `<our private directory>/<name>` (round 6), or a bare name (earlier heads); nothing else is touched.
    const nested = /^(\.coedit-\d+-[0-9a-f]{12})\/([^/]+)$/.exec(staging);
    const safe = nested || (!staging.includes('/') && staging !== '..' && staging !== '.');
    const found = safe ? await fs.promises.lstat(parent.at(staging)).catch(() => null) : null;
    if (found && found.ino === marker.ino && found.dev === marker.dev) await fs.promises.unlink(parent.at(staging)).catch(() => {});
    if (nested) await fs.promises.rmdir(parent.at(nested[1])).catch(() => {}); // Only if empty.
    finished.push(marker.recovery);
    await fs.promises.unlink(file).catch(() => {});
  }
  return finished;
}
