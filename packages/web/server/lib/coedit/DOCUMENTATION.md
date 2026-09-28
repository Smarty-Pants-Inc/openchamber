# Co-edit Module Documentation

## Purpose
Keep a real file on disk and a live co-editing room (Yjs) in step, so people co-edit a worktree file while agents, git
and tools keep writing the same file (smartyfs#18, co-editing slice 1). The file on disk stays the truth.

## Entrypoints and structure
- `packages/web/server/lib/coedit/disk-bridge.js`: `createDiskBridge({ root, file, doc })`, the disk side of one room.
  The Hocuspocus room layer (a room per open file, with the Files view's auth and project admission) comes next and
  owns admission. This module owns the disk rules below.

## Contract
- `root` and `file` are canonical (`realpath`) absolute paths; `file` is inside `root`. The constructor refuses anything else.
- `load()` seeds the room's `Y.Text` named `content` (`TEXT`) from the file and starts a watch on its directory.
- **Outside writes** (an agent, git, a tool, a replace by rename) are merged into the room as the **minimal text diff**
  (`fast-diff`) from the text last read to the text now on disk. The diff is applied to a copy of the room as it was at
  that read, and that copy's update is merged into the room. Edits people made since the read are kept; Yjs merges both.
  Bridge changes carry the origin `DISK_ORIGIN` (`'disk'`).
- **`save()`** writes the room's text only if the file's content hash equals the last read or write; otherwise it merges the
  outside write first and retries (up to 5 times, then `{ ok: false, reason: 'busy' }`). The write goes to a
  temp file in the same directory, keeps the file mode, and is renamed over the file after one more hash check.
  Known window: an outside write in the few ms between that check and the rename is overwritten (POSIX has no
  compare-and-rename). The bridge's own write is recognised by its hash and not merged back.
- **Containment:** every read and write re-resolves the file's directory and the file with `realpath`. A directory that
  now resolves outside `root` throws (`left its project`), and so does a file that became a symlink (`is a link`). Nothing
  outside the project is read or written.
- **Delete:** a missing file is never recreated by `save()`, which returns `{ ok: false, reason: 'gone' }` and sets
  `state().gone`. A later outside write brings the file back into the room (merged).
- `close()` stops the watch.
