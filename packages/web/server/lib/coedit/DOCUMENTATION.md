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
- **Save = one attempt to publish** (`publish`); there is no automatic merge-and-save:
  1. The current file (read through an fd, `O_NOFOLLOW`) must hash (raw bytes) to the revision last read. Otherwise
     the result is `changed` (or `gone` if missing: a deleted file is never recreated).
  2. Those exact bytes are kept first in `recoveryDir` (0700, outside the project, `O_EXCL` names: never replaced).
  3. The staging file is created `O_EXCL|O_NOFOLLOW` with the file's mode, written and fsynced. Its inode is ours.
  4. Right before the rename: the staging name must still be our inode with `nlink` 1 (else `unverified`), and
     the file must still be the same inode with the same hash (else `changed`).
  5. Rename, then fsync the directory (an error is thrown, never swallowed). The file must now be our staging inode
     (else `unverified`). The replaced revision is reread whole through the fd held since step 1. If a write through
     an old fd changed it, those bytes are kept for recovery too, and the result is `raced`.
  - **Any result but ok is a conflict:** `onConflict(conflict)` and `state().conflict`, with its recovery path. The
    base does not advance; the room merges the disk on the next sync, and the person saves again.
  - Remaining window: a whole-file replace by rename that lands between step 4's check and the rename (microseconds)
    is displaced without a copy. Every other displaced revision is kept.
- `root`, `file` and `recoveryDir` must be canonical absolute paths; `file` must be inside `root`, and `recoveryDir`
  outside it. The constructor refuses anything else. Non-UTF-8 files are refused.
- `close()` stops the watch.
