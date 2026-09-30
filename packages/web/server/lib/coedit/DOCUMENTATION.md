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
- **The helper runs as its own account** (smartyfs#32). In production it is the **coedit-fs service**: systemd starts
  one helper per connection to `OPENCHAMBER_COEDIT_SOCKET` (`/run/smarty-coedit/fs.sock`, only the served account may
  connect), as the system account `smarty-coedit`, with its private directory `/var/lib/smarty-coedit/staging` (inside
  its own 0700 home). So no program running as the account it serves can reach its staged or displaced entries. The
  bridge sends the project root in the first request (`hello {root}`); nothing else is served before it.
  - **The service authorizes what a connection may name** (#412 finding 1). Any process of the served account can
    connect, so the helper itself checks: the root must belong to the served account, and must be neither the private
    directory, inside it, nor an ancestor of it (compared by device and inode, walking `..`). Paths resolve beneath
    the root with no links and no mount crossings (`RESOLVE_NO_XDEV`), so nothing beneath it reaches the private
    directory. A file's key (the prefix of its private entries) is computed by the helper from the admitted root and
    the path, never taken from the caller, so a connection reaches only its own root's entries.
  - **One file, one operation at a time, across connections** (#412 findings 1 and 3). Every publish, flush, list and
    dispose holds that file's lock (`<key>-lock` in the private directory, `flock`, waited for at most 25 s). A second
    connection never sees or touches another's transaction while it is in flight: its `list` waits for it. A publish
    whose connection has already closed when it gets the lock (or just before its exchange) is abandoned before any
    change. So recovery after a lost reply, which lists through the lock, never races a publish nobody will hear of.
    The lock files stay (one empty file per co-edited file).
  - **Transactions** (#412 rounds 2 to 5).
    - **Records:** before any change, each publish creates `<key>.<txn>.txn` in the private directory. It is an
      **immutable** record (the staged inode, and the hash of the originating bridge's secret token), made
      atomically: an unnamed file is written, `fsync`ed and `flock`ed, then linked, so it is never visible partial
      or unlocked. A publish that cannot establish it changes nothing, and a txn whose record or outcome already exists
      for the file is refused before anything is created. A cleanup removes a record only when it still holds the inode
      that same invocation linked, never another transaction's name (#412 round 6). The outcome is a separate immutable
      `<key>.<txn>.out` (`published` or `aborted`), made the same way. It is flushed again (file and directory) every
      time before anything relies on it, so an interrupted or unflushed outcome is never trusted.
    - **Ownership:** a connection owns a transaction while it holds the record's lock. Ownership is the FULL identity
      (the file's key and the txn), bound to the exact staged entry and its displaced inode, so a txn reused on
      another file grants nothing. Another live connection sees such an entry only as `owned` (no bytes), and its
      `dispose` refuses it.
    - **After a lost helper:** an unowned transaction's retained data stays its originating bridge's. Only that
      bridge's **token** (kept in this server process's memory, never on disk) lets a helper claim it: a bridge that
      reconnects, or is reopened in the same process, reclaims its pending revision and its late bytes. No other
      process can list its bytes or dispose it, ever, without the token (until it is an **old orphan**, 7 days).
    - **A gone origin** (#428): each record keeps the pid and start time of the process that connected. Only proof
      counts as exit: `kill(pid, 0)` returns ESRCH, or the pid is readable with another start time (reused). A hidden
      or unreadable `/proc` (`hidepid` returns ENOENT for a live process), or EPERM, counts as alive. Once its origin is
      proven gone, the **helper itself** recovers the orphan: when a lease shows no writer is left, it writes the
      final bytes into the recovery directory **its origin bound** (#428 round 2): the directory the originating
      connection named in `hello` is stored, with its device and inode, in the transaction's immutable record, and is
      reopened and re-verified at recovery. A later caller's `hello` never retargets it; a record with no verifiable
      destination is not recovered (the 7-day rule applies). The directory must be private: the served account owns
      it, no one else has any access (no other bits; ACL entries only for trusted accounts), and it is outside the
      project and the private directory. The copy is private too: 0600 for the helper plus one ACL entry letting the
      served account read and write it, and nothing else. It is fsynced, and uses the bridge's recovery-name format. A durable marker records the delivery,
      and only then is the entry removed. Callers get only metadata (the path and hash), never the bytes, and cannot
      dispose it. The restarted bridge shows each delivered copy once (`raced`). **Setup:** with the service, the
      recovery directory needs the same grant as a project root (`setfacl -m u:smarty-coedit:rwx <recovery dir>`).
    - Tokens are dropped only once their transaction verifiably needs them no more: a definite refusal, a disposed
      revision, or an `ack` that confirms no data is left. `list` fails closed: any failure to inspect a data entry (not
      ENOENT) fails the whole list, so a partial list never settles a lost reply. An `ack` that reports pending data
      keeps the token, and the bridge keeps looking until that data is enrolled and collected, against the hash of the
      revision it displaced, so a late write is kept (#428 round 3).
    - A settled token is also dropped when a complete list shows neither a record nor data of its transaction: an
      `ack` that removed the receipt but whose reply was lost leaves nothing else to find (smartyfs#37 item 16). A
      transaction still settling (its publish sent without a reply, or a lost reply not yet settled) keeps its token
      whatever a list shows: another connection can list the file before the helper takes the file's lock for that
      publish. Only transactions already settled when a list is SENT may be retired by it: its reply can arrive after
      a publish that settled meanwhile and now has data (#436).
    - **Outcome:** once the owner is gone, a missing outcome is decided from the staged name (our inode: `aborted`;
      another inode: `published`; a complete scan that finds none: `aborted`) and made durable **before** any
      recovery may remove the entry. A failed scan, stat, open, lock, read, write or flush is never taken as absence:
      the outcome is `unknown`, the bridge holds, and nothing is disposed.
    - **Acknowledgement:** a bridge that settled a lost reply `ack`s with its token. The receipt goes only when no
      data entry is left: while its data is pending, the record keeps guarding that data. The connection that
      published a transaction retires it when its own dispose succeeds (it heard the reply). A claim that disposes
      the data leaves the outcome for the originating bridge's `ack`. Records with no data left go after 30 days.
  - **Closing** says whether the helper is **quiescent** (`close()` resolves `{ quiescent }`). A spawned helper is
    killed and awaited. A service helper, which this account cannot kill, is sent `bye`: operations run one at a time,
    so its answer means none is in flight, and it then exits. Only that answer within `closeMs` gives
    `quiescent: true`; otherwise the result is `quiescent: false`, and the helper may still finish an operation
    already admitted (a later recovery of that file waits for its lock). A cut connection is never taken as proof. The helper **refuses to serve its own account**: unless
  it is given `--same-account` (tests and development only; the service never is), it exits 2 when the peer on its stdin
  socket (`SO_PEERCRED`) is its own uid, or when it runs as root. Without the socket, the bridge runs the helper as its
  own account only when `OPENCHAMBER_COEDIT_SAME_ACCOUNT=1` (tests, development); otherwise co-editing fails closed.
  - **Setup** (smarty-dev `setup/coedit/`): the account, its home and staging directory, the socket and service units
    (no bind mounts: the exchange between the staging directory and a project directory must stay on one mount), and
    the binary at `/usr/local/libexec/smarty-coedit/coedit-fs`. Per project root, its owner grants the helper write
    access: `setfacl -R -m u:smarty-coedit:rwX -m d:u:smarty-coedit:rwX <root>`.
  - **Admission trusts** the helper, the account it serves (its peer) and root. A directory owned by anyone else is
    refused, as are groups with other members. A directory with an extended ACL is allowed only when every entry
    that can **write** names a trusted account or a private group (search-only `x` entries on ancestors are fine).
  - **Files it publishes are owned by `smarty-coedit`.** A save's new inode cannot be given to the served account
    without `CAP_CHOWN` (not granted, org's decision). The helper gives it an ACL that keeps every principal's
    **effective** access (#412 finding 2): the original owner becomes a named entry with exactly its owner
    permissions; every other named entry and the original owning group keep their permissions after the original
    mask; the new mask is their union; other is kept; the helper's own group gets nothing. An ACL entry it does not
    understand refuses the publish.
  - **The lease needs `CAP_LEASE`** (#412 finding 4; code-lead's approval on #412 and smarty-dev#2251). The displaced
    revision is usually the served account's inode, and only its owner or a holder of `CAP_LEASE` may lease it. The
    unit grants that one capability. A lease refused for any reason but an open writer (`EAGAIN`) is an error, never
    "busy", and nothing is removed unleased. The owner keeps reading and writing it, and git and editors still replace it, but **the owner's
    `chmod` and `chown` on it fail**.
- **The helper or nothing.** One coedit-fs process per bridge, JSON lines on
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
- **The helper protocol is checked first.** `startHelper` sends `hello` before any request. A helper that does not
  answer protocol 3 (for example, an older build set through `OPENCHAMBER_COEDIT_FS`, which would not name staged
  entries by `txn`) is ended, and every call rejects.
- **Recovery names fit `NAME_MAX`.** A recovery copy's name is a time stamp, a random part and the file's name, cut from
  the front to fit 255 bytes, so a long file name can still be saved.
- **The helper process is bounded.** A bad or truncated reply line, or a call past its deadline (`timeoutMs`, default
  30 s), ends the helper (a spawned one is killed; a service connection is cut, see Closing above) and rejects every
  waiting call. `close()` waits for work in progress at most `closeMs` (default 5 s), then ends the helper: a spawned
  one is killed and awaited; a service connection is half-closed, and cut after 5 s. A lost helper (killed, crashed, past its
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
  insertion-only revision arrives or the person accepts the disk (`acceptDisk()`). While one is held, `save()`
  returns that conflict and writes nothing: the disk does not hold the room's text, so it is never reported as saved
  (smartyfs#33 A). A save with nothing new to write reads the file through the helper first: it is `ok` only if the
  disk holds the base, else `changed` (for example a `raced` save not yet synced) or `gone`, with nothing written,
  raised to the room like any other conflict (`onConflict`, `state().conflict`). A file it finds present clears
  `gone`; when it holds the base again, the save is `ok` and a `gone` or `changed` conflict is resolved (other
  conflicts stay until their own path clears them).
- **Save = one attempt to publish** over exactly the revision last read (`publish`):
  1. The file's bytes must still hash to that revision (else `changed`, or `gone`: a deleted file is never recreated).
     A copy is kept in `recoveryDir` (0700, outside the project, `O_EXCL`, fsynced), and so is **ours** (named
     `…-ours-<name>`), both **before** the helper call: a writer that read before the save may replace the file after
     it, and our revision must not then live only in the room. A failed copy throws with nothing sent; after the call
     nothing throws. A save the helper refuses removes its `-ours-` copy again.
  2. The helper checks the inode and hash again, writes ours to an `O_TMPFILE` in the private directory, and gives it
     the original's access: for its own file, the original's group (`fchown`; refused if it cannot) and access ACL,
     then its mode without set-user-ID or set-group-ID (our file must never run as us); for the served account's
     file, the mode without those bits, then the effective-access ACL above. It fsyncs it (after the chmod), reads it back, links it as a private
     entry and fsyncs the private directory.
     A recovery directory on another filesystem than the file is refused before any change. So is a path where another
     account could move the file's directory out of the project. For each directory from the root down to that
     directory's parent, it is refused when another account (not root) owns it; when others can write to it (the
     other bits, or the group bits of any group but our **private** group: our primary group with no other member and
     no other account's primary group) and it is not sticky; or when it is sticky and the child on our path belongs
     to another account (who may rename it). "Another account" means anyone but the trusted ones above. A directory on
     that path with an extended ACL that lets anyone else write is refused too: the mode bits (then the mask) hide it.
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
     - Ours was replaced, or written into, right after the exchange (`replaced`, `bytes`: **all** our bytes are
       compared through the staging fd the helper still holds, so an equal-length change to the same inode is caught,
       whether made after the readback in step 2 or after the exchange; smartyfs#33 A): the exchange is certain,
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
  - **Uncertain**: the base stays and the room holds. After a **lost reply**, `sync()` and `save()` settle it by its
    transaction's outcome (above), never by whether a data entry is there: `published` adopts the room's snapshot
    (a displaced entry still there becomes pending, with its token); `aborted`, or no record within 30 days, is not
    published; owned or `unknown` holds. Otherwise (a reply that came back, but uncertain) they read the disk: our bytes
    there mean it was published (adopted as the base); the base's bytes mean it was not (cleared). Anything else stays an
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
- **Recovery retention** (smartyfs#37, org's decision 2026-09-29): recovery copies are named
  `<time>-<random>-<key>-[ours-]<file name>`. When a bridge loads a file, and then daily (`pruneMs`), it deletes a copy of
  that file only when it is **older than 7 days and not among the file's newest 20**. It considers only regular files
  whose names match that pattern for its key and that this account owns; anything else in the directory is never
  touched.
- **Stress test** (smartyfs#32's acceptance): `node stress.mjs --seconds 120 --dir <scratch> [--seed <n>]` (`stress.test.js` runs it for 20 s in CI) runs three direct
  writers (in place, tmp + rename, append) against a bridge process that a person types into and saves, while the
  helper and the whole bridge process are SIGKILLed at random (a killed run takes its children with it: they read EOF on a stdin pipe from it, even after a SIGKILL). It exits 1 if any token a writer wrote, or any token of
  a save that reported published, is missing from the disk, the recovery directory and the private directory. For a
  published save that holds by construction (its `-ours-` copy), so the report also gives `onlyInOurCopy`: the
  saves that only that copy keeps, which a stale writer overwrote after they were published.
  `stress.test.js` runs the killed run under a keeper that leads its own process group, and its cleanup signals only
  that group while the keeper is still its unreaped child, so no reused pid is ever signalled (smartyfs#37 item 17).
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
With the service (above), the first residual below applies only when the helper runs as the served account
(`--same-account`: tests and development). The second remains: the served account owns its project directories.

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
