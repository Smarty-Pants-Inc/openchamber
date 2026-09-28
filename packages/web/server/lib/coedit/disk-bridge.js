import fs from 'fs';
import path from 'path';
import diff from 'fast-diff';
import * as Y from 'yjs';

import { finishInterruptedSaves, hashBytes, inside, openParent, publish, readSettled } from './safe-file.js';

/** The room's shared text (y-codemirror.next binds any Y.Text; the client uses this name). */
export const TEXT = 'content';
/** Room changes made by the bridge carry this origin, so a room can tell disk merges from people. */
export const DISK_ORIGIN = 'disk';
/** A revision this much shorter than the text last read is not merged without a person's word (net-lead round 3). */
/** Whether `to` removes any text of `from` (net-lead round 4: a partial write that removes text is not merged unasked). */
const REMOVES = (from, to) => diff(from, to).some(([op]) => op === diff.DELETE);
/** Off unless enabled: the room layer that shows conflicts to people is not in production yet (code-lead, round 4). */
export const coeditEnabled = () => process.env.OPENCHAMBER_COEDIT === '1';

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
  enabled = coeditEnabled(),
}) {
  if (!enabled) throw new Error('Co-editing is off (OPENCHAMBER_COEDIT)');
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
    if (found.notice) result.notice = found.notice;
    return result;
  };

  // Outside text is merged unasked only as insertions. A revision that removes text may be a writer that truncated and
  // paused (net-lead round 4: C, pause, then CB would undo the room's deletion of B): it is a conflict until the person
  // accepts the disk (acceptDisk) or an insertion-only revision arrives; the room keeps its text, the base stays.
  let held = null;
  const sync = () => serial(async () => {
    if (closed || base === null) return;
    const disk = await withParent((parent) => readSettled(parent, name, settleMs));
    if (disk === null) gone = true;
    else if (disk.hash === baseHash) {
      gone = false;
      held = null;
    } else if (REMOVES(baseText, disk.text)) {
      if (held?.hash !== disk.hash) raise({ conflict: disk.text.length === 0 ? 'truncated' : 'removed' });
      held = disk;
    } else {
      held = null;
      merge(disk);
    }
  });

  return {
    load: () => serial(async () => {
      if (closed) throw new Error('Co-edited file is closed');
      // Watching starts before the first read, so a write during the load is seen.
      watcher = watch(path.dirname(file), (_event, changed) => {
        if (changed && String(changed) !== name) return;
        clearTimeout(timer);
        timer = setTimeout(() => void sync().catch((error) => {
          console.error(JSON.stringify({ type: 'smarty.coedit-sync-failed', file: name, error: String(error?.message ?? error) }));
        }), debounceMs);
      });
      watcher.on?.('error', (error) => {
        console.error(JSON.stringify({ type: 'smarty.coedit-watch-failed', file: name, error: String(error?.message ?? error) }));
      });
      const interrupted = await withParent((parent) => finishInterruptedSaves(parent, recoveryDir, file));
      const disk = await withParent((parent) => readSettled(parent, name, settleMs));
      if (disk === null) throw new Error('Co-edited file does not exist');
      if (interrupted.length) {
        raise({ conflict: 'interrupted', recovery: interrupted[0], notice: 'A save of this file was interrupted: its previous version is in the recovery folder.' });
      }
      doc.transact(() => text.insert(0, disk.text), DISK_ORIGIN);
      base = Y.encodeStateAsUpdate(doc);
      baseText = disk.text;
      baseHash = disk.hash;
    }),
    /** The person accepts the held revision on disk (it removes text): it is merged into the room. */
    acceptDisk: () => serial(async () => {
      if (closed || !held) return;
      merge(held);
      held = null;
      conflict = null;
    }),
    /** Merges a settled outside write into the room now (the watcher also calls it). */
    sync,
    /** { ok: true } | { ok: false, conflict: 'gone' | 'changed' | 'unverified' | 'raced' | 'escaped', recovery? }. */
    save: () => serial(async () => {
      if (closed || base === null) throw new Error('Co-edited file is not loaded');
      const next = text.toString();
      if (next === baseText) return { ok: true };
      const snapshot = Y.encodeStateAsUpdate(doc); // Taken with `next`, before any await.
      const result = await withParent((parent) => publish(parent, name, next, baseHash, { recoveryDir, target: file, hooks }));
      if (result.conflict === 'gone') gone = true;
      // Not published, or someone else's file was installed in its place (`foreign`): the base stays, so the next
      // sync reads what is on disk as an outside change (security pass round 6, item 1).
      if (!result.ok && (!result.published || result.foreign)) return raise(result);
      // Published (ok, or a conflict found after our bytes reached disk): the base follows what was written, so the
      // next sync does not replay the room's edit (net-lead round 4); a conflict is still shown.
      base = snapshot;
      baseText = next;
      baseHash = hashBytes(Buffer.from(next, 'utf8'));
      if (!result.ok) return raise(result);
      conflict = null;
      return { ok: true };
    }),
    state: () => ({ gone, loaded: base !== null, conflict }),
    /** Stops watching; resolves once any read or save in progress has finished. */
    close() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
      return queue.catch(() => {});
    },
  };
}
