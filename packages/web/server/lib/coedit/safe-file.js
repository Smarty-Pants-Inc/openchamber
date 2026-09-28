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
  await fs.promises.mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  const kept = path.join(recoveryDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}-${name}`);
  const handle = await fs.promises.open(kept, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
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
export async function publish(parent, name, text, expectedHash, { recoveryDir, hooks = {} }) {
  await parent.verify();
  const current = await openFile(parent, name);
  if (current === null) return { conflict: 'gone' };
  const staging = `.${name}.coedit-${process.pid}-${randomBytes(6).toString('hex')}`;
  let stagingHandle = null;
  let ours = null;
  let published = false;
  try {
    if (current.hash !== expectedHash) return { conflict: 'changed' };
    const recovery = await keepForRecovery(recoveryDir, name, current.bytes);
    await parent.verify();
    stagingHandle = await fs.promises.open(parent.at(staging), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, current.stat.mode & 0o7777);
    await stagingHandle.writeFile(text, 'utf8');
    await stagingHandle.sync();
    ours = await stagingHandle.stat();
    await hooks.beforePublish?.({ staging: parent.at(staging) });
    await parent.verify();
    const named = await fs.promises.lstat(parent.at(staging)).catch(() => null);
    const again = await openFile(parent, name);
    if (again) await again.handle.close();
    if (!named || named.ino !== ours.ino || named.dev !== ours.dev || named.nlink !== 1) return { conflict: 'unverified', recovery };
    if (!again || again.stat.ino !== current.stat.ino || again.hash !== expectedHash) return { conflict: 'changed', recovery };
    await fs.promises.rename(parent.at(staging), parent.at(name));
    published = true;
    await hooks.afterRename?.();
    await parent.sync();
    const now = await fs.promises.lstat(parent.at(name)).catch(() => null);
    if (!now || now.ino !== ours.ino) return { conflict: 'unverified', recovery };
    // The replaced revision, reread whole through the fd held since the check: a write made through an old fd
    // meanwhile is kept for recovery, and shown.
    const whole = await readWhole(current.handle, (await current.handle.stat()).size);
    if (hashBytes(whole) !== expectedHash) {
      return { conflict: 'raced', recovery: await keepForRecovery(recoveryDir, name, whole) };
    }
    return { ok: true, recovery };
  } finally {
    await stagingHandle?.close();
    await current.handle.close();
    if (!published && ours) {
      // Only our own staging inode is removed; a name that now points elsewhere is left alone.
      const named = await fs.promises.lstat(parent.at(staging)).catch(() => null);
      if (named && named.ino === ours.ino && named.dev === ours.dev) await fs.promises.unlink(parent.at(staging)).catch(() => {});
    }
  }
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
