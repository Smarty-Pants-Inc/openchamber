import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
const ANCHORED = fs.existsSync('/proc/self/fd'); // Linux: a path under /proc/self/fd/<dir fd> is resolved by the kernel.
const STABLE_TRIES = 6;
const STABLE_PAUSE_MS = 30;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);

/**
 * The directory of a co-edited file, opened from the project root one component at a time with O_NOFOLLOW, and held
 * by its fd. On Linux every later operation goes through /proc/self/fd/<fd>/<name>, so a directory swapped for a link
 * after the walk cannot redirect it. `verify()` checks the held directory is still the one at its path under the root
 * (a directory moved or linked away since): it runs after the temp file exists and again right before it goes in.
 */
export async function openParent(root, file) {
  const dir = path.dirname(file);
  if (!inside(root, dir)) throw new Error('Co-edited file left its project');
  let fd = await fs.promises.open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    let walked = root;
    for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
      walked = path.join(walked, part);
      const next = await fs.promises
        .open(ANCHORED ? `/proc/self/fd/${fd.fd}/${part}` : walked, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        .catch((error) => {
          throw error.code === 'ELOOP' || error.code === 'ENOTDIR' ? new Error('Co-edited file left its project') : error;
        });
      await fd.close();
      fd = next;
    }
  } catch (error) {
    await fd.close().catch(() => {});
    throw error;
  }
  const held = await fd.stat();
  const at = (name) => (ANCHORED ? `/proc/self/fd/${fd.fd}/${name}` : path.join(dir, name));
  return {
    at,
    async verify() {
      const real = await fs.promises.realpath(dir).catch(() => null);
      const now = real === dir ? await fs.promises.stat(dir).catch(() => null) : null;
      if (!now || !same(now, held)) throw new Error('Co-edited file left its project');
    },
    sync: () => fd.sync().catch(() => {}),
    close: () => fd.close().catch(() => {}),
  };
}

/**
 * A completed revision of `name`, or null when it is missing: its identity, size and mtime unchanged across the read
 * and a short pause after it, and still the file at the path (a writer still writing is waited out; a paused writer's
 * later bytes arrive as the next revision and merge as a diff). Valid UTF-8 only; hashed as raw bytes. A link is
 * refused, never followed.
 */
export async function readStable(parent, name) {
  for (let attempt = 0; attempt < STABLE_TRIES; attempt += 1) {
    const handle = await fs.promises.open(parent.at(name), O_RDONLY | O_NOFOLLOW).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error.code === 'ELOOP' ? new Error('Co-edited file is a link') : error;
    });
    if (handle === null) return null;
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error('Co-edited file is not a regular file');
      const bytes = await handle.readFile();
      await sleep(STABLE_PAUSE_MS); // Unchanged across the read and a short pause after it: a completed revision.
      const after = await handle.stat();
      const current = await fs.promises.lstat(parent.at(name)).catch(() => null);
      if (unchanged(before, after) && bytes.length === after.size && current && same(current, after)) {
        let text;
        try {
          text = utf8.decode(bytes);
        } catch {
          throw new Error('Co-edited file is not UTF-8 text');
        }
        const id = { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, mode: after.mode };
        return { text, hash: hashBytes(bytes), id };
      }
    } finally {
      await handle.close();
    }
    await sleep(STABLE_PAUSE_MS);
  }
  throw new Error('Co-edited file keeps changing');
}

/**
 * Puts `text` in place of `name` only if `name` is still exactly the revision `expected` (identity, size, mtime).
 * Returns 'ok', 'changed' (someone else's revision is there now; nothing of theirs was replaced), 'gone' (deleted:
 * never recreated) or { raced: text } (an append through an old fd landed in the replaced revision; merge it).
 *
 * The current file is first moved aside (rename is atomic, so a delete or replace in the gap shows as ENOENT or a new
 * identity), then the temp file is linked in (link never replaces, so a file created in the gap wins, EEXIST).
 * ponytail: between the move and the link the path is briefly missing (microseconds); a reader then sees no file,
 * never a wrong one.
 */
export async function replaceGuarded(parent, name, text, expected, hooks = {}) {
  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmp = `.${name}.coedit-${tag}`;
  const aside = `.${name}.coedit-old-${tag}`;
  const handle = await fs.promises.open(parent.at(tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, expected.mode & 0o7777);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let moved = false;
  try {
    await hooks.afterTemp?.();
    await parent.verify();
    await hooks.beforeSwap?.();
    await parent.verify();
    try {
      await fs.promises.rename(parent.at(name), parent.at(aside));
      moved = true;
    } catch (error) {
      if (error.code === 'ENOENT') return 'gone';
      throw error;
    }
    const old = await fs.promises.lstat(parent.at(aside));
    if (!unchanged(old, expected)) {
      // Theirs goes back (never over a newer one); if it cannot, the moved copy is kept, not deleted.
      await fs.promises.link(parent.at(aside), parent.at(name)).catch(() => { moved = false; });
      return 'changed';
    }
    await hooks.beforeLink?.();
    try {
      await fs.promises.link(parent.at(tmp), parent.at(name));
    } catch (error) {
      if (error.code === 'EEXIST') return 'changed'; // Created in the gap: theirs stays; ours is merged and saved again.
      throw error;
    }
    const after = await fs.promises.lstat(parent.at(aside));
    if (!unchanged(after, old)) {
      return { raced: (await fs.promises.readFile(parent.at(aside))).toString('utf8') };
    }
    return 'ok';
  } finally {
    await fs.promises.unlink(parent.at(tmp)).catch(() => {});
    if (moved) await fs.promises.unlink(parent.at(aside)).catch(() => {});
    await parent.sync();
  }
}
