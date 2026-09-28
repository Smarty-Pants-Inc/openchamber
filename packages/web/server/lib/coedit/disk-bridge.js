import fs from 'fs';
import path from 'path';
import diff from 'fast-diff';
import * as Y from 'yjs';

import { hashBytes, inside, openParent, readStable, replaceGuarded } from './safe-file.js';

/** The room's shared text (y-codemirror.next binds any Y.Text; the client uses this name). */
export const TEXT = 'content';
/** Room changes made by the bridge carry this origin, so a room can tell disk merges from people. */
export const DISK_ORIGIN = 'disk';
const SAVE_ATTEMPTS = 5;

/**
 * The disk side of one co-edited file (smartyfs#18, slice 1). The file stays the truth that agents, git and tools use.
 * The file operations and their race rules are in safe-file.js; this module keeps the room and the disk in step.
 *
 * - load(): the room starts from the file's text.
 * - An outside write (agent, git, a tool) is merged into the room as the minimal diff from the text last read to the
 *   text now on disk. It is applied to a copy of the room as it was at that read, and that copy's update is merged into
 *   the room, so edits people made meanwhile are kept (Yjs merges both). Only completed revisions are merged.
 * - save(): the room's text replaces the file only if the file is still the revision last read; otherwise the outside
 *   write is merged first and the save retried. It never reports ok over someone else's write.
 * - A deleted file is never recreated by a save (`gone`); a later outside write brings it back into the room.
 *
 * `root` and `file` must be canonical (realpath) absolute paths, as the room's admission resolves them.
 */
export function createDiskBridge({ root, file, doc, watch = fs.watch, debounceMs = 50, hooks = {} }) {
  if (!path.isAbsolute(root) || !path.isAbsolute(file) || !inside(root, file) || file === root) {
    throw new Error('Co-edited file must be inside its project');
  }
  const name = path.basename(file);
  const text = doc.getText(TEXT);
  let base = null; // The room's state whose text was on disk at the last read or write.
  let baseText = '';
  let last = null; // That revision: { hash, id }.
  let gone = false;
  let queue = Promise.resolve();
  let watcher = null;
  let timer = null;
  let closed = false;
  const serial = (work) => (queue = queue.then(work, work));
  const read = async () => {
    const parent = await openParent(root, file);
    try {
      return await readStable(parent, name);
    } finally {
      await parent.close();
    }
  };

  /** Applies the change `from` → `to` to a copy of the room at `at` (whose text is `from`), then merges it in. */
  const mergeChange = (at, from, to) => {
    const fork = new Y.Doc();
    Y.applyUpdate(fork, at);
    const forkText = fork.getText(TEXT);
    fork.transact(() => {
      let index = 0;
      for (const [op, part] of diff(from, to)) {
        if (op === diff.EQUAL) index += part.length;
        else if (op === diff.DELETE) forkText.delete(index, part.length);
        else {
          forkText.insert(index, part);
          index += part.length;
        }
      }
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(fork, Y.encodeStateVectorFromUpdate(at)), DISK_ORIGIN);
    return Y.encodeStateAsUpdate(fork);
  };
  const merge = (disk) => {
    base = mergeChange(base, baseText, disk.text);
    baseText = disk.text;
    last = { hash: disk.hash, id: disk.id };
    gone = false;
  };

  const sync = () => serial(async () => {
    if (closed || base === null) return;
    const disk = await read();
    if (disk === null) gone = true;
    else if (disk.hash !== last.hash) merge(disk);
  });

  return {
    async load() {
      const disk = await read();
      if (disk === null) throw new Error('Co-edited file does not exist');
      doc.transact(() => text.insert(0, disk.text), DISK_ORIGIN);
      base = Y.encodeStateAsUpdate(doc);
      baseText = disk.text;
      last = { hash: disk.hash, id: disk.id };
      watcher = watch(path.dirname(file), (_event, changed) => {
        if (changed && String(changed) !== name) return;
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
        if (disk.hash !== last.hash) {
          merge(disk); // Changed since the last read: merged into the room first, then saved.
          continue;
        }
        const next = text.toString();
        if (next === disk.text) return { ok: true };
        const snapshot = Y.encodeStateAsUpdate(doc); // Taken with `next`, before any await.
        const parent = await openParent(root, file);
        let result;
        try {
          result = await replaceGuarded(parent, name, next, disk.id, hooks);
        } finally {
          await parent.close();
        }
        if (result === 'gone') {
          gone = true;
          return { ok: false, reason: 'gone' };
        }
        if (result === 'changed') continue; // The next read merges theirs.
        const written = await read();
        const oldBase = base;
        base = snapshot;
        baseText = next;
        last = written && written.text === next ? { hash: written.hash, id: written.id } : { hash: hashBytes(Buffer.from(next)), id: null };
        if (result !== 'ok') {
          // An append through an old fd landed in the replaced revision: merged in (from that revision), saved again.
          mergeChange(oldBase, disk.text, result.raced);
          continue;
        }
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
