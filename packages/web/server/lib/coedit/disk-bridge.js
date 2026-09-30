import fs from 'fs';
import path from 'path';
import diff from 'fast-diff';
import * as Y from 'yjs';

import {
  dispose, DISTURBED_NOTICE, finishInterruptedSaves, hashBytes, inside, keyOf, publish, readFile, pruneRecovery, readSettled, startHelper, testHooks, tokensFor, forgetToken, settledToken, collectRecovered,
  UNCERTAIN_NOTICE, UNSYNCED_NOTICE,
} from './safe-file.js';

/** Shown while outside writes cannot reach the room (the watcher failed); cleared once watching resumes. */
export const UNWATCHED_NOTICE = 'Changes on disk are not being followed right now: this file may be out of date.';

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
 * - save(): one attempt to publish the room's text over exactly the revision last read. Anything else (the file
 *   changed since, a revision replaced meanwhile) is a CONFLICT: reported to the room (`onConflict`,
 *   `state().conflict`), never retried or merged silently. Every revision a save replaces is kept in `recoveryDir`.
 * - A save whose outcome is unknown (`published: 'uncertain'`) holds the room: nothing is merged or saved until the
 *   disk shows ours (adopted) or the base (not published); any other revision stays a conflict.
 * - A published save whose flush failed (`unsynced`) is not acknowledged, and its displaced revision is not removed,
 *   until a later flush succeeds; a cached read of our bytes is no durability receipt.
 * - A deleted file is never recreated by a save (`gone`); a later outside write brings it back into the room.
 * - A watcher error is shown (`unwatched`); watching restarts on its own (at most `retryLimit` tries) and catches up.
 *
 * `root` and `file` must be canonical (realpath) absolute paths, as the room's admission resolves them.
 */
export function createDiskBridge({
  root, file, doc, recoveryDir, onConflict = () => {}, watch = fs.watch, debounceMs = 50, settleMs = 200, hooks,
  enabled = coeditEnabled(), timeoutMs = 30_000, retryMs = 1000, retryLimit = 600, closeMs = 5000, pruneMs = 86_400_000,
}) {
  if (!enabled) throw new Error('Co-editing is off (OPENCHAMBER_COEDIT)');
  if (!path.isAbsolute(root) || !path.isAbsolute(file) || !inside(root, file) || file === root) {
    throw new Error('Co-edited file must be inside its project');
  }
  if (!recoveryDir || !path.isAbsolute(recoveryDir) || inside(root, recoveryDir)) {
    throw new Error('Co-editing needs a recovery directory outside the project');
  }
  const name = path.basename(file);
  const rel = path.relative(root, file);
  const text = doc.getText(TEXT);
  const key = keyOf(root, rel);
  // Tests pass `hooks` (named helper pauses and faults); only then is the helper started to honour them.
  const forTests = hooks !== undefined;
  hooks ??= {};
  // Fails closed where the helper cannot run (smartyfs#32). Its private dir holds staging and displaced revisions.
  const spawnHelper = () => startHelper(root, path.join(recoveryDir, '.staging'), { timeoutMs, testHooks: forTests });
  let current = spawnHelper();
  let respawns = 0;
  /**
   * The helper, started again when it was lost (killed, crashed, past its deadline), at most `retryLimit` times in a row
   * (smartyfs#34 item 1). What a lost call may have done is already held (uncertain, unsynced); the new one settles it.
   */
  const helper = {
    alive: () => !closed,
    call: async (request) => {
      if (!current.alive()) {
        if (closed) throw new Error('Co-edited file is closed');
        if (respawns >= retryLimit) throw new Error('coedit-fs keeps failing');
        respawns += 1;
        await current.close();
        if (closed) throw new Error('Co-edited file is closed'); // close() ran meanwhile: start nothing after it.
        current = spawnHelper();
      }
      const reply = await current.call(request);
      respawns = 0;
      return reply;
    },
    close: (options) => current.close(options),
  };
  let pending = [];
  let orphans = false; // Orphans of a gone process whose bytes the helper has not recovered yet (#428).
  const shown = new Set(); // The helper's recovered copies already shown by this bridge.
  const showRecovered = (recovered = []) => {
    for (const { marker, path: copy } of recovered) {
      if (shown.has(marker)) continue;
      shown.add(marker);
      raise({ conflict: 'raced', published: true, recovery: copy, notice: DISTURBED_NOTICE });
    }
  }; // Private entries still open for writing: removed once no one writes to them.
  let uncertain = null; // A save that may or may not have been published: { snapshot, next, nextHash, seen }.
  let unsynced = null; // A published save not yet flushed: { raised, entry }. Nothing is acknowledged until a flush succeeds.
  let base = null; // The room's state whose text was on disk at the last read or publish.
  let baseText = '';
  let baseHash = null;
  let gone = false;
  let conflict = null;
  let queue = Promise.resolve();
  let watcher = null;
  let timer = null;
  let retryTimer = null;
  let retries = 0;
  let rewatchTimer = null;
  let pruneTimer = null;
  let rewatches = 0;
  let closed = false;
  const serial = (work) => (queue = queue.then(work, work));

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
    if (found.published) result.published = found.published;
    if (found.recovery) result.recovery = found.recovery;
    if (found.notice) result.notice = found.notice;
    return result;
  };

  // Outside text is merged unasked only as insertions. A revision that removes text may be a writer that truncated and
  // paused (net-lead round 4: C, pause, then CB would undo the room's deletion of B): it is a conflict until the person
  // accepts the disk (acceptDisk) or an insertion-only revision arrives; the room keeps its text, the base stays.
  let held = null;
  /**
   * Completes a failed flush (the file's directory, then the private dir). Until it succeeds the save stays a conflict
   * (raised once) and nothing is acknowledged; a helper that cannot answer keeps it held.
   */
  const confirmDurable = async () => {
    if (!unsynced) return true;
    const reply = await helper.call({ ...testHooks(hooks), op: 'flush', path: rel, entry: unsynced.entry }).catch(() => null);
    if (reply?.ok) {
      unsynced = null;
      if (!uncertain && conflict?.conflict === 'unverified') conflict = null;
      return true;
    }
    if (!unsynced.raised) raise({ conflict: 'unverified', published: true, notice: UNSYNCED_NOTICE });
    unsynced.raised = true;
    return false;
  };
  /** Retries the removal of displaced revisions; bytes written into one meanwhile are kept and shown (residual 4). */
  const disposePending = async () => {
    // Orphans the helper could not recover yet (a writer still held them): look again, and keep what it recovered.
    if (orphans) {
      const again = await collectRecovered(helper, key, rel, recoveryDir).catch(() => null);
      if (again) {
        const known = new Set(pending.map((revision) => revision.entry));
        const mine = again.mine.filter((revision) => !known.has(revision.entry));
        pending.push(...mine);
        // Still looking while an orphan waits, or while a token this process kept (its data not yet verified gone) has
        // no revision enrolled: e.g. its old helper still holds the lock while it exits (bounded by retryLimit).
        const unenrolled = Object.values(tokensFor(key)).some((token) => !pending.some((revision) => revision.token === token));
        orphans = again.orphans || (unenrolled && !uncertain);
        showRecovered(again.recovered);
      }
    }
    // A displaced revision stays while the save that displaced it is not durable.
    if (!(await confirmDurable())) return scheduleRetry();
    const still = [];
    for (const revision of pending) {
      const done = await dispose(helper, key, revision, recoveryDir, rel, hooks).catch((error) => {
        logError('smarty.coedit-dispose-failed', error); // A permanent refusal is logged, never taken as 'busy'.
        return { busy: true, hash: revision.hash };
      });
      if (done.late) raise({ conflict: 'raced', published: true, recovery: done.late, notice: DISTURBED_NOTICE });
      if (done.busy) still.push({ ...revision, hash: done.hash });
      if (done.unsynced) unsynced ??= { raised: false };
    }
    pending = still;
    if (unsynced) await confirmDurable();
    scheduleRetry();
  };
  /** While revisions are pending or a flush failed, retries on its own (at most `retryLimit` times). */
  const scheduleRetry = () => {
    const waiting = pending.length > 0 || unsynced !== null || orphans;
    if (!waiting) retries = 0;
    if (closed || retryTimer || !waiting || retries >= retryLimit) return;
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!closed) void serial(disposePending).catch(() => {});
    }, retryMs);
  };
  /**
   * Settles a save whose reply was lost by its transaction record in the private dir (#412 round 3), the authoritative
   * outcome, whatever the file holds now (an agent may have written since). The helper creates the record before any
   * change and resolves it when its owner is gone; it outlives the entry (another bridge may already have recovered
   * that) until this bridge acks it. `published`: the base follows ours, and a displaced entry still there is kept as
   * pending. `aborted`, or no record at all (the helper died before any change): not published. Still owned by a live
   * connection, unreadable, or an uncertainty older than the records are kept (30 days): held.
   */
  const settleByPrivateDir = async () => {
    const reply = await helper.call({ ...testHooks(hooks), op: 'list', path: rel, tokens: tokensFor(key) }).catch(() => null);
    if (!reply?.ok) return false;
    const txn = uncertain.lost;
    const record = (reply.records ?? []).find((r) => r.txn === txn);
    if (record && record.state !== 'published' && record.state !== 'aborted') return false; // Owned, or unknown.
    if (!record && Date.now() - uncertain.since > 29 * 86_400_000) return false;
    const known = new Set(pending.map((revision) => revision.entry));
    const fresh = reply.entries.filter((entry) => !known.has(entry.entry) && entry.entry.startsWith(`${key}.${txn}-`));
    if (fresh.some((entry) => entry.owned)) return false;
    if (record?.state === 'published') {
      base = uncertain.snapshot;
      baseText = uncertain.next;
      baseHash = uncertain.nextHash;
      gone = false;
      for (const entry of fresh) pending.push({ entry: entry.entry, hash: uncertain.baseHash, token: uncertain.token }); // Late bytes are kept.
    } else {
      for (const entry of fresh) await dispose(helper, key, { entry: entry.entry, hash: uncertain.nextHash }, recoveryDir, rel, hooks);
    }
    // Settled: the receipt may go (the helper keeps the record while its data is pending, #412 round 5). The token is
    // dropped only on a VERIFIED no-data ack: an ack that says data is still pending, or one that fails, keeps it,
    // and a later list enrolls that data (#428 round 3; smartyfs#37 item 15).
    const acked = await helper.call({ ...testHooks(hooks), op: 'ack', path: rel, txn, token: uncertain.token }).catch(() => null);
    const enrolled = pending.some((revision) => revision.token === uncertain.token);
    settledToken(key, txn); // Its outcome is read: a later complete list decides whether its token is still needed.
    if (acked?.ok && !acked.pending && !enrolled) forgetToken(key, txn);
    else if (!enrolled) orphans = true; // Look again (list with this token) until its data is enrolled or gone.
    uncertain = null;
    if (!unsynced) conflict = null;
    scheduleRetry(); // Entries enrolled here are collected on their own (#412 round 5, P2).
    return true;
  };
  /** Settles an uncertain save by the disk: ours is adopted, the base clears it; anything else holds (returns false). */
  const settleUncertain = async () => {
    if (!uncertain) return true;
    // A lost reply is settled only by the private dir (its list waits for any operation still in flight on this file,
    // #412 finding 3); if that cannot be read, the save stays held: the disk alone could clear it too early.
    if (uncertain.lost) {
      if (await settleByPrivateDir()) return true;
      if (uncertain.seen !== 'unlisted') raise({ conflict: 'unverified', published: 'uncertain', notice: UNCERTAIN_NOTICE });
      uncertain.seen = 'unlisted';
      return false;
    }
    const disk = await readFile(helper, rel);
    if (disk?.hash === uncertain.nextHash) {
      base = uncertain.snapshot;
      baseText = uncertain.next;
      baseHash = uncertain.nextHash;
    } else if (disk === null || disk.hash !== baseHash) {
      const seen = disk?.hash ?? 'gone';
      if (uncertain.seen !== seen) raise({ conflict: 'unverified', published: 'uncertain', notice: UNCERTAIN_NOTICE });
      uncertain.seen = seen;
      return false;
    }
    uncertain = null;
    if (!unsynced) conflict = null; // Adopted by its hash; a pending flush still holds the conflict.
    return true;
  };
  /** Retention (smartyfs#37): this file's recovery copies, at load and then every `pruneMs` (a day) while open. */
  const prune = () => pruneRecovery(recoveryDir, key).catch((error) => logError('smarty.coedit-prune-failed', error));
  const schedulePrune = () => {
    if (closed) return;
    pruneTimer = setTimeout(() => {
      pruneTimer = null;
      void prune().then(schedulePrune);
    }, pruneMs);
    pruneTimer.unref?.();
  };
  const logError = (type, error) => console.error(JSON.stringify({ type, file: name, error: String(error?.message ?? error) }));
  /** Watches the file's directory; a watcher error stops it, is shown, and watching restarts (bounded). */
  const startWatch = () => {
    watcher?.close(); // Never two live watchers.
    watcher = null;
    const current = watch(path.dirname(file), (_event, changed) => {
      if (changed && String(changed) !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => void sync().catch((error) => logError('smarty.coedit-sync-failed', error)), debounceMs);
    });
    watcher = current;
    current.on?.('error', (error) => {
      logError('smarty.coedit-watch-failed', error);
      if (watcher !== current) return;
      current.close();
      watcher = null;
      if (closed) return;
      raise({ conflict: 'unwatched', notice: UNWATCHED_NOTICE });
      scheduleRewatch();
    });
  };
  const scheduleRewatch = () => {
    if (closed || rewatchTimer || rewatches >= retryLimit) return;
    rewatches += 1;
    rewatchTimer = setTimeout(() => {
      rewatchTimer = null;
      if (closed) return;
      try {
        startWatch();
      } catch (error) {
        logError('smarty.coedit-watch-failed', error);
        scheduleRewatch();
        return;
      }
      rewatches = 0;
      // Outside writes made while unwatched are caught up now.
      void sync().then(() => {
        if (conflict?.conflict === 'unwatched') conflict = null;
        // A transient refusal that carried the watcher warning keeps only itself (#445 astra r2).
        else if (conflict?.kept?.conflict === 'unwatched') conflict = { conflict: conflict.conflict, transient: true, at: conflict.at };
      }).catch((error) => logError('smarty.coedit-sync-failed', error));
    }, retryMs);
  };
  const sync = () => serial(async () => {
    if (closed || base === null) return;
    await disposePending();
    if (!(await settleUncertain())) return;
    const disk = await readSettled(helper, rel, settleMs);
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
      if (base !== null) throw new Error('Co-edited file is already loaded');
      // Watching starts before the first read, so a write during the load is seen; a failed load releases it.
      startWatch();
      let interrupted;
      let disk;
      let flushed;
      try {
        // A flush that failed before a reopen or restart is not forgotten: the file's directory is flushed first, and
        // until that succeeds nothing is disposed or acknowledged (a cached read is no durability receipt).
        flushed = await helper.call({ ...testHooks(hooks), op: 'flush', path: rel }).then((reply) => reply.ok === true, () => false);
        interrupted = await finishInterruptedSaves(helper, key, rel, recoveryDir, { durable: flushed, hooks });
        orphans = interrupted.orphans;
        await prune();
        disk = await readSettled(helper, rel, settleMs);
        if (disk === null) throw new Error('Co-edited file does not exist');
      } catch (error) {
        // The failed load owns its watcher and any restart it scheduled.
        clearTimeout(rewatchTimer);
        rewatchTimer = null;
        rewatches = 0;
        watcher?.close();
        watcher = null;
        throw error;
      }
      if (interrupted.finished.length) {
        raise({ conflict: 'interrupted', recovery: interrupted.finished[0], notice: 'A save of this file was interrupted: its previous version is in the recovery folder.' });
      }
      for (const late of interrupted.late) raise({ conflict: 'raced', published: true, recovery: late, notice: DISTURBED_NOTICE });
      showRecovered(interrupted.recovered);
      pending.push(...interrupted.pending);
      schedulePrune();
      if (!flushed || interrupted.unsynced) {
        unsynced = { raised: true };
        raise({ conflict: 'unverified', published: true, notice: UNSYNCED_NOTICE });
      }
      scheduleRetry();
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
    /** { ok: true } | { ok: false, conflict: 'gone' | 'changed' | 'unverified' | 'raced', published?, recovery?, notice? }. */
    save: () => serial(async () => {
      if (closed || base === null) throw new Error('Co-edited file is not loaded');
      if (!(await settleUncertain())) return { ok: false, conflict: 'unverified', published: 'uncertain' };
      await disposePending(); // Completes a failed flush first, then removes what it held.
      if (unsynced) return { ok: false, conflict: 'unverified', published: true };
      // A held disk revision (it removes text) waits for acceptDisk(): nothing can be saved over it, and the disk does
      // not hold the room's text, so this is never reported as saved (smartyfs#33 A).
      if (held) return { ok: false, conflict: held.text.length === 0 ? 'truncated' : 'removed' };
      const next = text.toString();
      if (next === baseText) {
        // Nothing new to write: saved only if the disk holds the base now. A known mismatch (a raced save not yet
        // synced) or a deleted file is reported, never acknowledged; nothing is written over it (#445 security r1).
        const disk = await readFile(helper, rel);
        // Any unresolved conflict (a raced save's recovery warning, a stopped watcher) is carried through these
        // transient refusals, never replaced by them, and is what their resolution leaves; it clears only through its
        // own path (#445 security r3, astra r2).
        const kept = conflict?.transient ? conflict.kept : conflict;
        // Shown to the room like any other refusal (onConflict, state().conflict: smartyfs#33 P3).
        const refuse = (reason) => raise({ conflict: reason, transient: true, ...(kept && { recovery: kept.recovery, notice: kept.notice, kept }) });
        if (disk === null) {
          gone = true; // Observed absent here, as a sync would.
          return refuse('gone');
        }
        // The file exists: whatever this path said before about its absence or its bytes is refuted or restated here.
        gone = false;
        if (disk.hash !== baseHash) return refuse('changed');
        // It holds the base: saved. A gone or changed refusal from this path is resolved to the warning it carried;
        // other conflicts (a watcher failure, a raced save's notice) stay until their own path clears them (#445 r2).
        if (conflict?.transient) conflict = conflict.kept ?? null;
        return { ok: true };
      }
      const snapshot = Y.encodeStateAsUpdate(doc); // Taken with `next`, before any await.
      const { pending: displaced, unsynced: notFlushed, lost, token, ...result } = await publish(helper, rel, next, baseHash, { recoveryDir, key, hooks });
      if (displaced) pending.push(displaced);
      if (notFlushed) unsynced = { raised: true, entry: displaced?.entry }; // Raised with this result; a flush confirms it.
      scheduleRetry();
      if (result.conflict === 'gone') gone = true;
      // Unknown whether ours reached the disk: the base stays, and sync or save settles it by the disk's hash.
      if (result.published === 'uncertain') {
        uncertain = { snapshot, next, nextHash: hashBytes(Buffer.from(next, 'utf8')), baseHash, lost: lost ?? null, token, since: Date.now(), seen: null };
        return raise(result);
      }
      // Not published: the base stays, so the next sync reads what is on disk as an outside change.
      if (!result.ok && !result.published) return raise(result);
      // Published (ok, or a conflict found after our bytes reached disk): the base follows what was written, so the
      // next sync does not replay the room's edit (net-lead round 4); a conflict is still shown.
      base = snapshot;
      baseText = next;
      baseHash = hashBytes(Buffer.from(next, 'utf8'));
      gone = false; // Ours is the file now.
      if (!result.ok) return raise(result);
      conflict = null;
      return { ok: true };
    }),
    state: () => ({ gone, loaded: base !== null, conflict }),
    /** Stops watching and retrying; waits for work in progress (at most `closeMs`), then ends the helper. */
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      clearTimeout(rewatchTimer);
      clearTimeout(pruneTimer);
      watcher?.close();
      // A displaced revision still pending stays in the private dir; the next load keeps and removes it.
      let bound;
      const waited = new Promise((done) => { bound = setTimeout(done, closeMs); });
      // Resolves { quiescent }: whether the helper provably can no longer act (#412 round 2, finding 2).
      return Promise.race([queue.catch(() => {}), waited]).finally(() => clearTimeout(bound)).then(() => helper.close({ boundMs: closeMs }));
    },
  };
}
