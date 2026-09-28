# Co-edit Module Documentation

## Purpose
Keep a real file on disk and a live co-editing room (Yjs) in step, so people co-edit a worktree file while agents, git
and tools keep writing the same file (smartyfs#18, co-editing slice 1). The file on disk stays the truth.

## Entrypoints and structure
- `disk-bridge.js`: `createDiskBridge({ root, file, doc, recoveryDir, onConflict })`, the disk side of one room.
- `safe-file.js`: the file operations (`openParent`, `readSettled`, `publish`, `keepForRecovery`).
- The Hocuspocus room layer (a room per open file, with the Files view's auth and project admission) comes next and
  owns admission; it shows conflicts to the people in the room.

## Design (net-lead's review, round 2): never lose bytes; any doubt is a visible conflict
Uncoordinated writers to one file cannot be made lossless by more checks. So the bridge publishes only when it can
verify every step, keeps every revision it replaces, and turns every uncertainty into a conflict the person sees.

- **Anchored or nothing.** The file's directory is opened from `root` one component at a time with
  `O_DIRECTORY|O_NOFOLLOW` and held by its fd. All operations go through `/proc/self/fd/<fd>/<name>`. Where that
  anchoring does not exist, co-editing throws instead of falling back to plain paths. The held directory's current
  location (`readlink`) must be inside `root` before any write, and again right before the publish.
- **Room display** (outside writes into the room): only a **settled** revision is merged (the same bytes and identity
  in two reads `settleMs`, default 200 ms, apart). It goes in as the minimal text diff (`fast-diff`) from the text last read,
  applied to a copy of the room as it was then, so people's edits are kept. Bridge changes carry `DISK_ORIGIN`
  (`'disk'`). A writer that pauses longer than `settleMs` is shown as a revision; its next write is the next revision.
  This changes only what the room shows. Nothing is written to disk from it.
- **Truncations are not merged silently** (net-lead round 3). A revision that empties the file, or cuts a text of 256
  bytes or more to under a quarter, may be a writer that truncated and paused. It is a `truncated` conflict: the room
  keeps its text and the base does not move. A fuller revision later merges normally, or the person accepts the disk
  (`acceptDisk()`).
- **Save = one attempt to publish** (`publish`); there is no automatic merge-and-save:
  1. The current file (read through an fd, `O_NOFOLLOW`) must hash (raw bytes) to the revision last read. Otherwise
     the result is `changed` (or `gone` if missing: a deleted file is never recreated).
  2. Those exact bytes are kept first in `recoveryDir` (0700, outside the project, `O_EXCL` names: never replaced).
  3. The staging file is created `O_EXCL|O_NOFOLLOW` with the file's mode, written and fsynced. Its inode is ours.
  4. Right before the rename: the staging name must still be our inode with `nlink` 1 (else `unverified`), and
     the file must still be the same inode with the same hash (else `changed`).
  5. Rename, then fsync the directory (an error is thrown, never swallowed). The file must now be our staging inode
     with its size and mtime unchanged (else `unverified`), and the held directory still inside the root (else
     `escaped`, and a `smarty.coedit-escaped` log line for an alert). The replaced revision is reread whole through the fd held since step 1. If a write through
     an old fd changed it, those bytes are kept for recovery too, and the result is `raced`.
  - **Any result but ok is a conflict:** `onConflict(conflict)` and `state().conflict`, with its recovery path. The
    base does not advance; the room merges the disk on the next sync, and the person saves again.
  - `unverified`, `raced` and `escaped` carry the notice "Another writer changed this file during your save: check the
    recovery folder."
- **Crash recovery:** after the recovery copy, `publish` writes a marker (`<copy>.pending.json`: target, staging name,
  copy), removed when the save finishes either way. `load()` finishes any marker of its file that a crash left: it
  removes the staging file (only a name the bridge creates), keeps the copy, and raises an `interrupted` conflict with
  a notice.

## Accepted limits (slice 1)
- **Displaced revisions without writer coordination** (net-lead's round-3 P1-2; accepted by org, tracked in
  smartyfs#32). A whole-file replace by rename landing between the last check and the rename (microseconds), or an
  old-fd write after the recovery reread, can be displaced without a copy. The post-save notice above makes the case
  visible when it can be seen.
- **A directory moved outside the project during a save** (round-3 P1-1). An fd pins no location, and true confinement
  needs a mount namespace. The move is detected right after the rename and reported (`escaped`, plus a log line). What
  lands there is the room's own text, in a place the mover chose.
- `root`, `file` and `recoveryDir` must be canonical absolute paths; `file` must be inside `root`, and `recoveryDir`
  outside it. The constructor refuses anything else. Non-UTF-8 files are refused.
- `close()` stops the watch.
