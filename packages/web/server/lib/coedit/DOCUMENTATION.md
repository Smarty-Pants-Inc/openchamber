# Co-edit Module Documentation

## Purpose
Keep a real file on disk and a live co-editing room (Yjs) in step, so people co-edit a worktree file while agents, git
and tools keep writing the same file (smartyfs#18, co-editing slice 1). The file on disk stays the truth.

## Entrypoints and structure
- `disk-bridge.js`: `createDiskBridge({ root, file, doc })`, the disk side of one room (merges and saves).
- `safe-file.js`: the file operations and their race rules (`openParent`, `readStable`, `replaceGuarded`).
- The Hocuspocus room layer (a room per open file, with the Files view's auth and project admission) comes next and
  owns admission.

## Contract
- `root` and `file` are canonical (`realpath`) absolute paths; `file` is inside `root`. The constructor refuses anything else.
- `load()` seeds the room's `Y.Text` named `content` (`TEXT`) from the file and starts a watch on its directory.
- **Only completed revisions are read** (`readStable`). The file's identity, size and mtime must be unchanged across the
  read and a 30 ms pause after it, and it must still be the file at the path; otherwise the read is retried. A writer
  that pauses longer shows as two revisions, and the second merges as a diff. The text must be valid UTF-8 (else the
  read throws), and it is hashed as raw bytes.
- **Outside writes** (an agent, git, a tool, a replace by rename) are merged into the room as the **minimal text diff**
  (`fast-diff`) from the text last read to the new revision. The diff is applied to a copy of the room as it was at that
  read, and that copy's update is merged into the room. Edits people made since the read are kept; Yjs merges both.
  Bridge changes carry the origin `DISK_ORIGIN` (`'disk'`).
- **`save()`** writes the room's text only over the exact revision last read (`replaceGuarded`), and never reports ok
  over someone else's write. Otherwise it merges and retries (up to 5 times, then `{ ok: false, reason: 'busy' }`).
  1. The temp file is written in the same directory (`O_EXCL|O_NOFOLLOW`, the file's mode) and fsynced.
  2. The current file is moved aside (atomic rename). A delete in the gap gives `ENOENT`, and the save returns `gone`.
     A different revision there (by identity, size or mtime) is put back and the save returns `changed`.
  3. The temp file is **linked** in. A file created at the path in the gap wins (`EEXIST`), and the save returns `changed`.
  4. The moved-aside revision is checked again. An append through an old fd that landed there is merged, and the save
     writes again. The directory is fsynced.
  - Known window: between steps 2 and 3 the path is missing for microseconds; a reader then sees no file, never a wrong
    one. An append through an old fd after step 4's check is lost with the old revision.
- **Containment:** the file's directory is opened from `root` one component at a time with `O_DIRECTORY|O_NOFOLLOW`, and
  held by its fd. On Linux all operations go through `/proc/self/fd/<fd>/<name>`, so a directory swapped for a link
  after the walk cannot redirect them. On every platform the held directory is checked (`realpath` plus dev/ino) after
  the temp file exists and again right before the swap; a mismatch throws `left its project`. A file that is a symlink
  is refused (`is a link`), never followed.
- **Delete:** a missing file is never recreated by `save()`, which returns `{ ok: false, reason: 'gone' }` and sets
  `state().gone`. A later outside write brings the file back into the room (merged).
- `close()` stops the watch.
