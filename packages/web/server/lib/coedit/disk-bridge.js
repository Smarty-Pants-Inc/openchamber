import fs from 'fs';
import path from 'path';
import diff from 'fast-diff';
import * as Y from 'yjs';

import { hashBytes, inside, openParent, publish, readSettled } from './safe-file.js';

/** The room's shared text (y-codemirror.next binds any Y.Text; the client uses this name). */
export const TEXT = 'content';
/** Room changes made by the bridge carry this origin, so a room can tell disk merges from people. */
export const DISK_ORIGIN = 'disk';

/**
 * The disk side of one co-edited file (smartyfs#18, slice 1). The file stays the truth that agents, git and tools use.
 * File operations and their rules are in safe-file.js; this module keeps the room and the disk in step.
 *
 * - load(): the room starts from the file's text.
 * - Outside writes (agent, git, a tool) are merged INTO the room as the minimal diff from the text last read to the
 *   settled text now on disk, applied to a copy of the room as it was at that read, so what people typed meanwhile is
 *   kept. This only changes what the room shows.
 * - save(): one attempt to publish the room's text over exactly the revision last read. Anything uncertain (the file
 *   changed since, a staging file that is not ours, a replaced revision written meanwhile) is a CONFLICT: reported to
 *   the room (`onConflict`, `state().conflict`), never retried or merged silently, and the base does not advance.
 *   Every revision a save replaces is kept in `recoveryDir` first.
 * - A deleted file is never recreated by a save (`gone`); a later outside write brings it back into the room.
 *
 * `root` and `file` must be canonical (realpath) absolute paths, as the room's admission resolves them.
 */
export function createDiskBridge({
  root, file, doc, recoveryDir, onConflict = () => {}, watch = fs.watch, debounceMs = 50, settleMs = 200, hooks = {},
}) {
  if (!path.isAbsolute(root) || !path.isAbsolute(file) || !inside(root, file) || file === root) {
    throw new Error('Co-edited file must be inside its project');
  }
  if (!recoveryDir || !path.isAbsolute(recoveryDir) || inside(root, recoveryDir)) {
    throw new Error('Co-editing needs a recovery directory outside the project');
  }
  const name = path.basename(file);
  const text = doc.getText(TEXT);
  let base = null; // The room's state whose text was on disk at the last read or publish.
  let baseText = '';
  let baseHash = null;
  let gone = false;
  let conflict = null;
  let queue = Promise.resolve();
  let watcher = null;
  let timer = null;
  let closed = false;
  const serial = (work) => (queue = queue.then(work, work));
  const withParent = async (work) => {
    const parent = await openParent(root, file);
    try {
      return await work(parent);
    } finally {
      await parent.close();
    }
  };

  const merge = (disk) => {
    const fork = new Y.Doc();
    Y.applyUpdate(fork, base);
    const forkText = fork.getText(TEXT);
    fork.transact(() => {
      let index = 0;
      for (const [op, part] of diff(baseText, disk.text)) {
        if (op === diff.EQUAL) index += part.length;
        else if (op === diff.DELETE) forkText.delete(index, part.length);
        else {
          forkText.insert(index, part);
          index += part.length;
        }
      }
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(fork, Y.encodeStateVectorFromUpdate(base)), DISK_ORIGIN);
    base = Y.encodeStateAsUpdate(fork);
    baseText = disk.text;
    baseHash = disk.hash;
    gone = false;
  };
  const raise = (found) => {
    conflict = { ...found, at: Date.now() };
    onConflict(conflict);
    const result = { ok: false, conflict: found.conflict };
    if (found.recovery) result.recovery = found.recovery;
    return result;
  };

  const sync = () => serial(async () => {
    if (closed || base === null) return;
    const disk = await withParent((parent) => readSettled(parent, name, settleMs));
    if (disk === null) gone = true;
    else if (disk.hash !== baseHash) merge(disk);
  });

  return {
    async load() {
      const disk = await withParent((parent) => readSettled(parent, name, settleMs));
      if (disk === null) throw new Error('Co-edited file does not exist');
      doc.transact(() => text.insert(0, disk.text), DISK_ORIGIN);
      base = Y.encodeStateAsUpdate(doc);
      baseText = disk.text;
      baseHash = disk.hash;
      watcher = watch(path.dirname(file), (_event, changed) => {
        if (changed && String(changed) !== name) return;
        clearTimeout(timer);
        timer = setTimeout(() => void sync().catch(() => {}), debounceMs);
      });
      watcher.on?.('error', () => {});
    },
    /** Merges a settled outside write into the room now (the watcher also calls it). */
    sync,
    /** { ok: true } | { ok: false, conflict: 'gone' | 'changed' | 'unverified' | 'raced', recovery? }. */
    save: () => serial(async () => {
      if (closed || base === null) throw new Error('Co-edited file is not loaded');
      const next = text.toString();
      if (next === baseText) return { ok: true };
      const snapshot = Y.encodeStateAsUpdate(doc); // Taken with `next`, before any await.
      const result = await withParent((parent) => publish(parent, name, next, baseHash, { recoveryDir, hooks }));
      if (result.conflict === 'gone') gone = true;
      if (!result.ok) return raise(result);
      base = snapshot;
      baseText = next;
      baseHash = hashBytes(Buffer.from(next, 'utf8'));
      conflict = null;
      return { ok: true };
    }),
    state: () => ({ gone, loaded: base !== null, conflict }),
    close() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
