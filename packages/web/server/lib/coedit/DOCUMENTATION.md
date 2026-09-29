# Co-edit Module Documentation

## Purpose
Keep a real file on disk and a live co-editing room (Yjs) in step, so people co-edit a worktree file while agents, git
and tools keep writing the same file (smartyfs#18, co-editing slice 1). The file on disk stays the truth.

**Off in production.** `createDiskBridge` throws unless `OPENCHAMBER_COEDIT=1` (or `enabled: true`). It turns on only in
the release that also has the room UI, which shows conflicts and notices to people (code-lead's decision on #340,
round 4); until then no conflict could be seen.

## Entrypoints and structure
- `disk-bridge.js`: `createDiskBridge({ root, file, doc, recoveryDir, onConflict })`, the disk side of one room.
- `safe-file.js`: `startHelper`, `readSettled`, `publish`, `dispose`, `keepForRecovery`, `finishInterruptedSaves`.
- `fs-helper/`: **coedit-fs**, a small Rust binary that does every file operation for the bridge (smartyfs#32; protocol
  below). Build: `cargo build --release` there; the bridge uses `fs-helper/target/release/coedit-fs`, or
  `OPENCHAMBER_COEDIT_FS`. Tests: `fs-helper/fs-helper.test.js`. The tests build it first (`fs-helper/ensure-built.js`),
  not a CI step: the workflow and `package.json` files are bound by the branding ledger (`test:brand`).
- The Hocuspocus room layer (a room per open file, with the Files view's auth and project admission) comes next; it
  shows conflicts and their notices to the people in the room.

## Design: never lose bytes silently; nothing is rolled back or guessed
- **The helper or nothing.** One coedit-fs process per bridge: `coedit-fs <root> <privateDir>`, JSON lines on
  stdin/stdout. It resolves every project path from the root with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|
  RESOLVE_NO_MAGICLINKS)` and opens files `O_NOFOLLOW|O_NONBLOCK` (a FIFO never blocks; only regular files are read).
  Without the helper (another OS, no binary), co-editing throws.
- **The recovery tree and the private directory.** JS creates each missing directory of `recoveryDir` (0700). On
  every start it then fsyncs the parent of each ancestor we own, so the tree's names are durable before it holds
  anything, including a tree left by an earlier start whose flush failed. A failed fsync fails closed. It refuses a
  `recoveryDir` that is a link, not ours, or writable by group or others. It opens `<recoveryDir>/.staging` with
  `O_NOFOLLOW` (a link there is refused before any change) and makes it 0700 with `fchmod` on that descriptor, never
  by path. The helper holds it by fd and exits unless we own it and it has no group or other bits. All staging, displaced revisions and cleanup live there, under
  `<key>.<unique>.staged` (`key`: the first 16 hex characters of sha256 of the project root, a NUL and the file's project-relative path, so two
  projects that share a recovery directory never collect each other's entries). A default ACL on it (inherited from
  its parent) is removed when the helper starts, and an access ACL on it is refused: so a parent whose default ACL
  has named entries (which also gives `.staging` an access ACL) makes the helper exit, and co-editing fails closed.
  Each publish names its staged entry `<key>.<txn>-<unique>.staged`: after a lost reply, the bridge finds exactly
  that save's entry. Another
  account cannot name, replace or write anything in it. The project namespace is changed only by the publishing
  exchange; the bridge never reads the project directory for cleanup, so a project file such as `.x.coedit-foo` is
  never touched.
- **The helper process is bounded.** A bad or truncated reply line, or a call past its deadline (`timeoutMs`, default
  30 s), kills the helper and rejects every waiting call. `close()` waits for work in progress at most `closeMs`
  (default 5 s), then kills the helper and resolves once it has exited. A lost helper (killed, crashed, past its
  deadline) is started again on the next call, at most `retryLimit` times in a row; what the lost call may have done
  is already held as uncertain or not yet flushed, and the new helper settles it.
- **Test hooks** (named pauses and faults) are honoured only by a helper started for tests (`startHelper(…, {
  testHooks: true })`, which the bridge does only when given `hooks`); `COEDIT_FS_TEST` is removed from its
  environment otherwise. Only `pause`, `pauseMs`, `fault`, `testOwners` and `testGroupMembers` pass, before the
  request's own fields, so a hook never replaces them.
- **Outside writes into the room** (an agent, git, a tool, a replace by rename). Only a **settled** revision is read:
  the same bytes and inode in two reads `settleMs` (default 200 ms) apart. It is merged **unasked only if it inserts
  text**: the minimal diff (`fast-diff`) from the text last read, applied to a copy of the room as it was then, so
  people's edits are kept. Bridge changes carry `DISK_ORIGIN` (`'disk'`). A revision that **removes** text may be a
  writer that truncated and paused (net-lead round 4): it is a conflict (`truncated` or `removed`) until an
  insertion-only revision arrives or the person accepts the disk (`acceptDisk()`).
- **Save = one attempt to publish** over exactly the revision last read (`publish`):
  1. The file's bytes must still hash to that revision (else `changed`, or `gone`: a deleted file is never recreated).
     A copy is kept in `recoveryDir` (0700, outside the project, `O_EXCL`, fsynced), and so is **ours** (named
     `…-ours-<name>`), both **before** the helper call: a writer that read before the save may replace the file after
     it, and our revision must not then live only in the room. A failed copy throws with nothing sent; after the call
     nothing throws. A save the helper refuses removes its `-ours-` copy again.
  2. The helper checks the inode and hash again, writes ours to an `O_TMPFILE` in the private directory, gives it the
     original's group (`fchown`; refused if it cannot) and access ACL, then its mode without set-user-ID or
     set-group-ID (our file must never run as us), fsyncs it (after the chmod), reads it back, links it as a private entry and fsyncs the private directory.
     A recovery directory on another filesystem than the file is refused before any change. So is a path where another
     account could move the file's directory out of the project. For each directory from the root down to that
     directory's parent, it is refused when another account (not root) owns it; when others can write to it (the
     other bits, or the group bits of any group but our **private** group: our primary group with no other member and
     no other account's primary group) and it is not sticky; or when it is sticky and the child on our path belongs
     to another account (who may rename it). A directory on that path with an extended access ACL is refused too:
     the ACL can grant a named account write access that the mode bits (then the mask) hide.
  3. It publishes with one `renameat2(RENAME_EXCHANGE)` between the private entry and the file (it fails if the file
     was deleted: `gone`). From here every reply says `published: true`; nothing is undone and nothing outside the
     private directory is unlinked.
  4. It fsyncs the file's directory, then the private directory, and observes: ours is installed, its bytes are ours,
     the directory is still beneath the root, and the displaced object is the checked revision.
     - All hold: ok. The displaced revision (now a private entry) is removed once no process has it open for writing
       (`dispose`, under a read lease); bytes written through an old descriptor meanwhile are kept in `recoveryDir`
       and shown (`raced`, notice "Another writer changed this file during your save: check the recovery folder.").
     - The displaced object is not the checked revision (someone replaced the file just before the exchange): `raced`,
       their revision kept for recovery.
     - Ours was replaced, or written into, right after the exchange (`replaced`, `bytes`): the exchange is certain,
       so this is an outside write to a published file. It is `raced` (published), the base follows ours, and the
       next sync treats the writer's revision as any other (so an agent's steady writes never stall the room).
     - Anything it cannot prove (a failed observation, the directory moved out of the project): `unverified` with
       `published: 'uncertain'`. A lost reply, a helper exit or a deadline after the request was sent is the same.
     - Durability is reported on its own (`synced`). A failed directory fsync (after the exchange, or when `dispose`
       flushes the private directory) makes the save `unverified` with `published: true`: the base follows ours, but
       the save is **not acknowledged** and the displaced revision is **not removed** until a `flush` (the file's
       directory, then the private directory) succeeds. `sync()`, `save()` and the retry timer try the flush; until
       it succeeds `save()` returns the conflict and publishes nothing. A read of our bytes (maybe from the page
       cache) never counts as a flush. A lost reply is treated as not flushed too.
     - This state survives a close or restart: `load()` flushes the file's directory first. If that fails, the
       private entries are kept for recovery but not disposed, `unverified` is raised, and `save()` holds until a
       flush succeeds. A failed flush while disposing them holds it the same way.
  - **Published** (ok or `raced`): the room's base moves to our bytes, so the next sync never replays the edit.
  - **Uncertain**: the base stays and the room holds. After a **lost reply**, `sync()` and `save()` first ask the
    private directory, the authoritative record, whatever the file holds now: a new entry with our bytes means the
    exchange never ran (it is removed; not published); a new entry with other bytes is the revision our exchange
    displaced (published: the base follows ours, and the entry is kept as pending); no new entry means it never got
    that far (not published). Otherwise they read the disk: our bytes there mean
    it was published (adopted as the base); the base's bytes mean it was not (cleared). Anything else stays an
    `unverified` conflict (raised once per disk revision): nothing is merged, and `save()` publishes nothing.
  - Any result but ok is a conflict (`onConflict`, `state().conflict`), with its recovery path.
- **Pending revisions**: a displaced revision still open for writing is retried on its own every `retryMs` (default
  1 s, at most `retryLimit`, default 600, tries) until it is removed, or its late bytes are kept and shown as `raced`.
  No sync or further write is needed.
- **Watching:** `load()` starts the directory watcher before its first read; a failed load closes it, and a second
  `load()` is refused. A failed load also cancels a restart its watcher scheduled, and a new watcher always replaces
  (closes) the old one. A watcher error closes it and raises `unwatched` ("Changes on disk are not being followed right
  now"); watching restarts after `retryMs` (at most `retryLimit` tries), catches up with a sync, and clears it.
- **`gone`** clears when an outside write brings the file back, or when a save publishes over it.
- **Stress test** (smartyfs#32's acceptance): `node stress.mjs --seconds 120 --dir <scratch> [--seed <n>]` (`stress.test.js` runs it for 20 s in CI) runs three direct
  writers (in place, tmp + rename, append) against a bridge process that a person types into and saves, while the
  helper and the whole bridge process are SIGKILLed at random (a killed run takes its children with it). It exits 1 if any token a writer wrote, or any token of
  a save that reported published, is missing from the disk, the recovery directory and the private directory. For a
  published save that holds by construction (its `-ours-` copy), so the report also gives `onlyInOurCopy`: the
  saves that only that copy keeps, which a stale writer overwrote after they were published.
- **Crash recovery:** `load()` lists the file's private entries (`list`), keeps each in `recoveryDir`, disposes it and
  raises `interrupted` with a notice. One still open for writing is enrolled as pending; a late write is `raced`. After
  a crash or kill at any point the file holds either the old or the new revision, whole.
- `root`, `file` and `recoveryDir` must be canonical absolute paths; `file` must be inside `root`, and `recoveryDir`
  outside it, on the same filesystem. Non-UTF-8 files are refused. `load()`, `acceptDisk()` and `save()` run one at a
  time.

## Accepted limits
- **An in-place writer of the same account** (`O_TRUNC` then write, no rename) can change the file at any moment.
  That is a writer, not a race: it shows as the next revision, and a revision it changed during a save is kept (`raced`).
- A displaced revision still open for writing after `retryLimit` tries, or at close, stays in the private directory;
  the next load keeps it for recovery and removes it.
- **Admission is read once per publish.** Owners, modes, ACLs and the group database are checked at the start of
  each publish; a change to them by a directory's owner during the save is not seen.
- **"Private group" is as complete as the account database.** Group members and other accounts' primary groups come
  from NSS (`getgrgid`, `getpwent`). A back end that does not enumerate (for example sssd with `enumerate = false`)
  can hide another account in our primary group. A group that cannot be read counts as shared.
- Linux ≥ 5.6 (`openat2`) and a filesystem with `RENAME_EXCHANGE` and `O_TMPFILE` are required; elsewhere co-editing
  fails closed.

## Residuals (not closed; accepted as limits by code-lead's SCOPE DECISIONs on #380)
These are limits, not guarantees. The real fix, a helper under another uid, is tracked by smartyfs#32 (the condition
of Paul's acceptance). Co-editing is **off by default** until then.
- **Same-account private-entry interference.** Accepted by [#380 5889338501](https://github.com/Smarty-Pants-Inc/openchamber/pull/380#issuecomment-5889338501),
  which applies Paul's ruling on [#340 5879551930](https://github.com/Smarty-Pants-Inc/openchamber/pull/340#issuecomment-5879551930)
  (item 2, entry `9ecb62a4`: any program running as his user interfering during a co-edit save) to exactly these two:
  1. **Staged-name substitution before the exchange.** A program running as our uid can replace the staged entry in
     the 0700 private directory between its link and the exchange; the exchange then publishes the substitute. A
     later observation may report it (`uncertain`), but it does not prevent it.
  2. **A disposal or cleanup unlink of a substituted private entry.** The read lease holds the opened inode, not its
     name: such a program can replace the entry before `dispose`'s unlink, or before the cleanup of a failed publish,
     and that unlink removes the substitute unchecked.
  No syscall makes a rename or an unlink conditional on an inode, so no stat is added: it would only narrow the window.
- **Same-account relocation.** Accepted by [#380 5888358581](https://github.com/Smarty-Pants-Inc/openchamber/pull/380#issuecomment-5888358581)
  (Paul's ruling, item 1). A program running as our uid can move the file's directory out of the project between our
  open and the exchange; we publish into the directory we checked, wherever it now is. A later observation may report
  it (`escaped`); a move after the last observation is not guaranteed to be reported. Nothing is rolled back.
  Relocation by **another account** is refused at admission (above); that check reads owners, modes and group
  membership once per publish, so a change to them during the save is not seen.
- **Durability is by fsync order** (the staged file after its chmod, the private directory, then the file's
  directory; a failed sync holds the save until a flush succeeds, never ok). A power-loss test is not possible here;
  fault tests prove the held state and its confirmation, and the kill tests at `beforeExchange` and `afterExchange`
  prove recovery at each boundary, not durability across a power cut. A `flush` after a publish whose flush failed
  syncs the directory it published into (held by the helper since), even if it has moved; after a helper restart that
  directory is no longer held, and the flush syncs the directory now at the file's path.
