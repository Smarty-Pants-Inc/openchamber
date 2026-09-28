# Co-edit Module Documentation

## Purpose
Keep a real file on disk and a live co-editing room (Yjs) in step, so people co-edit a worktree file while agents, git
and tools keep writing the same file (smartyfs#18, co-editing slice 1). The file on disk stays the truth.

**Off in production.** `createDiskBridge` throws unless `OPENCHAMBER_COEDIT=1` (or `enabled: true`). It turns on only in
the release that also has the room UI, which shows conflicts and notices to people (code-lead's decision on #340,
round 4); until then no conflict could be seen.

## Entrypoints and structure
- `disk-bridge.js`: `createDiskBridge({ root, file, doc, recoveryDir, onConflict })`, the disk side of one room.
- `safe-file.js`: the file operations (`openParent`, `readSettled`, `publish`, `keepForRecovery`, `finishInterruptedSaves`).
- The Hocuspocus room layer (a room per open file, with the Files view's auth and project admission) comes next; it
  shows conflicts and their notices to the people in the room.

## Design (net-lead's review): never lose bytes silently; any doubt is a visible conflict
Uncoordinated writers to one file cannot be made lossless by more checks. So the bridge publishes only when it can
verify every step, keeps a copy of the revision it replaces, and turns every uncertainty it can see into a conflict the
person sees. What it cannot see is listed under Accepted limits.

- **Anchored or nothing.** The file's directory is opened from `root` one component at a time with
  `O_DIRECTORY|O_NOFOLLOW` and held by its fd. All operations go through `/proc/self/fd/<fd>/<name>`. Where that
  anchoring does not exist, co-editing throws instead of falling back to plain paths. The held directory's current
  location (`readlink`) must be inside `root` before any write, and again right before and after the publish.
- **Outside writes into the room** (an agent, git, a tool, a replace by rename). Only a **settled** revision is read:
  the same bytes and identity in two reads `settleMs` (default 200 ms) apart. It is merged **unasked only if it inserts
  text**: the minimal diff (`fast-diff`) from the text last read, applied to a copy of the room as it was then, so
  people's edits are kept. Bridge changes carry `DISK_ORIGIN` (`'disk'`).
  - A revision that **removes** any text may be a writer that truncated and paused (net-lead round 4: `AB`, the room
    deletes `B`, a writer writes `C`, pauses, then `CB`). It is a conflict (`truncated` when the file is empty, else
    `removed`): the room keeps its text and the base does not move, until an insertion-only revision arrives or the
    person accepts the disk (`acceptDisk()`), which merges it.
  - This document is also the base a save publishes over, so what the room shows and what a save may replace are the
    same revision.
- **Save = one attempt to publish** (`publish`); there is no automatic merge-and-save:
  1. The current file (read through an fd, `O_NOFOLLOW`) must hash (raw bytes) to the revision last read. Otherwise
     the result is `changed` (or `gone` if missing: a deleted file is not recreated).
  2. A copy of those bytes is kept in `recoveryDir` (0700, outside the project, `O_EXCL` names, fsynced, its entry and a
     new directory's entry fsynced).
  3. The staging file is created `O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW` **inside a private directory** (`mkdir` 0700 next
     to the file, owner and mode checked, held by its fd), and it is renamed **from that fd**, not by name: another
     account that can write the project can rename or replace the directory's name but not its content (security pass
     round 6, item 1). A pending marker (in `recoveryDir/.pending/`,
     its own directory, recording the staging inode) is written and fsynced. The bytes are written, the mode set on the
     fd, the file fsynced, then **read back through the same fd**: bytes other than ours are `unverified`.
  4. Right before the rename: the staging name must still be our inode with `nlink` 1 (else `unverified`); the file at
     the path must be the same inode with the same hash (else `changed`); and our revision must still have a name
     (`nlink` > 0 on the held fd), and a file must be there (else `gone`).
  5. Rename. **From here the publication is recorded (`published`) before anything that can throw**, and every exit,
     including an exception (a failed directory fsync, a failed recovery read), is reported as a committed conflict,
     so the room's base follows what was written and the next sync never replays the edit. An exception keeps the
     pending marker, so the next load also reports the interrupted save. Then the directory is fsynced; the directory
     must still be inside the root (else `escaped`, plus a `smarty.coedit-escaped` log line); the file at the path must
     be our inode **and its content, read back through our own held fd, must hash to the bytes we meant to write**
     (else `unverified`: another writer changed it, even at equal length). The replaced revision is reread whole
     through the fd held since step 1; a write through an old fd found there is kept for recovery too (`raced`).
     What the rename installed is looked at **first thing after it**: a file that is **not our inode** there was
     substituted before the rename (only the same account can reach inside the private directory: the accepted
     same-uid limit). It is `unverified` with `foreign`, and the room's base does **not** follow it, so the next sync
     sees it as an outside revision. Our inode there means our bytes were published: a replacement found by the later
     checks is a conflict, but the base still follows our bytes, so the next sync never replays the edit (round 7).
  6. Release: both handles are closed, then our staging inode and our private directory (only while they are still
     ours) are removed, **each step on its own**. A release error after the rename keeps the committed result (a
     conflict with `published`, the base follows it) and the pending marker (security pass round 6, item 2).
  - **Any result but ok is a conflict:** `onConflict(conflict)` and `state().conflict`, with its recovery path.
    `unverified`, `raced` and `escaped` after the rename carry the notice "Another writer changed this file during your
    save: check the recovery folder."
- **Crash recovery:** `load()` finishes a marker of its file that a crash left. It removes the staging file only if it
  is still the very inode the marker recorded, keeps the copy, and raises `interrupted` with a notice. A malformed
  marker is logged (`smarty.coedit-marker-malformed`) and left for a person.
- `root`, `file` and `recoveryDir` must be canonical absolute paths; `file` must be inside `root`, and `recoveryDir`
  outside it. The constructor refuses anything else. Non-UTF-8 files are refused. Watch errors and background sync
  failures are logged. `load()`, `acceptDisk()` and `save()` run one at a time; `close()` stops the watch and resolves
  once they have finished.

## Accepted limits (slice 1)
- **Displaced revisions without writer coordination** (net-lead's round-3 P1-2; accepted by org, SCOPE DECISION on
  #340, tracked in smartyfs#32). Between the last checks of step 4 and the rename, another writer's whole-file replace
  by rename, or an append through an old fd after the step-5 reread, can be displaced without a copy. A crash after the
  rename but before the step-5 checks also leaves no second copy. The step-5 notice makes the case visible when it can
  be seen.
- **A directory moved outside the project during a save** (round-3 P1-1; same SCOPE DECISION). An fd pins no location,
  and true confinement needs a mount namespace. The move is detected right after the rename and reported (`escaped`,
  plus a log line). What lands there is the room's own text, in a place the mover chose.
- **A delete in the last instant before the rename** (round-4 item 6). Step 4 catches a delete made before it; a delete
  between that check and the rename is undone by the rename. Linux has no `renameat2(RENAME_NOREPLACE)` variant that
  replaces only an existing file. Proposed as an accepted limit, with the SCOPE DECISION on #340.
