import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import diff from 'fast-diff';
import * as Y from 'yjs';

/** The room's shared text (y-codemirror.next binds any Y.Text; the client uses this name). */
export const TEXT = 'content';
/** Room changes made by the bridge carry this origin, so a room can tell disk merges from people. */
export const DISK_ORIGIN = 'disk';
const SAVE_ATTEMPTS = 5;
const hashOf = (text) => createHash('sha256').update(text).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

/**
 * The disk side of one co-edited file (smartyfs#18, slice 1). The file stays the truth that agents, git and tools use.
 *
 * - load(): the room starts from the file's text.
 * - An outside write (agent, git, a tool) is merged into the room as the minimal diff from the text last read to the
 *   text now on disk. It is applied to a copy of the room as it was at that read, and that copy's update is merged into
 *   the room, so edits people made meanwhile are kept (Yjs merges both).
 * - save(): the room's text is written only if the file is unchanged since the last read; otherwise the outside write
 *   is merged first and the save retried. Writes are atomic (a temp file in the same directory, then rename).
 * - Nothing outside `root` is read or written: the file's canonical path is checked against the canonical root at
 *   every read and write, so a symlink swapped in later cannot redirect it.
 * - A deleted file is never recreated by a save (`gone`); a later outside write brings it back into the room.
 *
 * `root` and `file` must be canonical (realpath) absolute paths, as the room's admission resolves them.
 */
export function createDiskBridge({ root, file, doc, fsPromises = fs.promises, watch = fs.watch, debounceMs = 50 }) {
  if (!path.isAbsolute(root) || !path.isAbsolute(file) || !inside(root, file) || file === root) {
    throw new Error('Co-edited file must be inside its project');
  }
  const text = doc.getText(TEXT);
  let base = null; // The room's state whose text was on disk at the last read or write.
  let baseText = '';
  let lastHash = null;
  let gone = false;
  let queue = Promise.resolve();
  let watcher = null;
  let timer = null;
  let closed = false;
  const serial = (work) => (queue = queue.then(work, work));

  /** The file's canonical path, or null when it is missing; throws when it would leave the project. */
  const contained = async () => {
    const dir = await fsPromises.realpath(path.dirname(file));
    if (!inside(root, dir)) throw new Error('Co-edited file left its project');
    const target = await fsPromises.realpath(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (target !== null && (target !== path.join(dir, path.basename(file)) || !inside(root, target))) {
      throw new Error('Co-edited file is a link'); // A symlinked file could point anywhere: refused, not followed.
    }
    return target === null ? null : target;
  };
  const read = async () => {
    const target = await contained();
    if (target === null) return null;
    const content = await fsPromises.readFile(target, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return content === null ? null : { text: content, hash: hashOf(content) };
  };

  /** Merges the change from the last read to `disk` into the room (see above). */
  const merge = (disk) => {
    const fork = new Y.Doc();
    Y.applyUpdate(fork, base);
    const forkText = fork.getText(TEXT);
    fork.transact(() => {
      let at = 0;
      for (const [op, part] of diff(baseText, disk.text)) {
        if (op === diff.EQUAL) at += part.length;
        else if (op === diff.DELETE) forkText.delete(at, part.length);
        else {
          forkText.insert(at, part);
          at += part.length;
        }
      }
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(fork, Y.encodeStateVectorFromUpdate(base)), DISK_ORIGIN);
    base = Y.encodeStateAsUpdate(fork);
    baseText = disk.text;
    lastHash = disk.hash;
    gone = false;
  };

  const sync = () => serial(async () => {
    if (closed || base === null) return;
    const disk = await read();
    if (disk === null) gone = true;
    else if (disk.hash !== lastHash) merge(disk);
  });

  return {
    async load() {
      const disk = await read();
      if (disk === null) throw new Error('Co-edited file does not exist');
      doc.transact(() => text.insert(0, disk.text), DISK_ORIGIN);
      base = Y.encodeStateAsUpdate(doc);
      baseText = disk.text;
      lastHash = disk.hash;
      watcher = watch(path.dirname(file), (_event, name) => {
        if (name && String(name) !== path.basename(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void sync().catch(() => {}), debounceMs);
      });
      watcher.on?.('error', () => {});
    },
    /** Merges an outside write now (the watcher also calls it). */
    sync,
    /** { ok: true } | { ok: false, reason: 'gone' | 'busy' }; throws when the file would leave the project. */
    save: () => serial(async () => {
      if (closed || base === null) throw new Error('Co-edited file is not loaded');
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
        const disk = await read();
        if (disk === null) {
          gone = true;
          return { ok: false, reason: 'gone' };
        }
        if (disk.hash !== lastHash) {
          merge(disk); // Changed since the last read: merged into the room first, then saved.
          continue;
        }
        const next = text.toString();
        const snapshot = Y.encodeStateAsUpdate(doc); // Taken with `next`, before any await.
        if (next !== disk.text) {
          const target = await contained();
          if (target === null) continue;
          const { mode } = await fsPromises.stat(target);
          const tmp = path.join(path.dirname(target), `.${path.basename(target)}.coedit-${process.pid}-${Date.now()}`);
          await fsPromises.writeFile(tmp, next, { encoding: 'utf8', mode, flag: 'wx' });
          try {
            // ponytail: an outside write between this check and the rename (a few ms) is overwritten. POSIX has no
            // compare-and-rename; the watcher's next sync shows the loss window is that small, not silent drift.
            const again = await read();
            if (again === null || again.hash !== lastHash || (await contained()) !== target) continue;
            await fsPromises.rename(tmp, target);
          } finally {
            await fsPromises.unlink(tmp).catch(() => {});
          }
        }
        base = snapshot;
        baseText = next;
        lastHash = hashOf(next);
        return { ok: true };
      }
      return { ok: false, reason: 'busy' };
    }),
    state: () => ({ gone, loaded: base !== null }),
    close() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
