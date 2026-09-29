//! coedit-fs --same-account <root> <private dir> | coedit-fs --socket <private dir>: the co-edit disk bridge's file operations (openchamber#380, smartyfs#32).
//!
//! One process per bridge; JSON lines in, one JSON line per request out. Project paths are relative to the root and
//! resolved with openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS). Opens never block (O_NONBLOCK)
//! and only regular files are read.
//!
//! The only change this helper makes in the project is one renameat2(RENAME_EXCHANGE) per publish. Staging, displaced
//! revisions and cleanup live in the private dir, held by fd, which must be ours and 0700 (else exit 2). Nothing is
//! ever rolled back: after the exchange every reply says `published: true`, and what cannot be proven is reported as
//! `uncertain`, not guessed. Durability is reported apart from identity: `synced: false` when a directory fsync
//! failed; only a later `flush` that succeeds confirms it. Limits: the exchange goes into the directory checked at the start, even if another writer
//! has since moved it out of the root (then reported `uncertain: "escaped"`); a process of our own uid can enter the
//! private dir.
//!
//! Operations:
//! - `hello {root?}` -> `{ok:true,protocol:3}` (the bridge refuses any other protocol; in socket mode the first hello
//!   names the root, and read/publish/flush before it are refused)
//! - `read {path}` -> `{ok,ino,dev,hash,data(base64)}` | `{ok:false,conflict:"gone"}`
//! - `publish {path,ino,dev,hash,data,key}` -> not published: `{ok:false,conflict:"gone"|"changed"}` | `{ok:false,error}`;
//!   published: `{ok,published,synced,ino,dev,displaced}` (ok only when synced) | `{ok:false,published,synced,conflict:"raced",displaced}`
//!   | `{ok:false,published,synced,uncertain,displaced}`. `displaced` is the private entry holding the replaced object.
//! - `flush {path,entry?}` -> `{ok:true,ino}` | `{ok:false,synced:false}`: fsyncs the directory a publish went into (held
//!   by its displaced `entry` since its flush failed; else the file's directory now), then the private dir.
//! - `dispose {key,entry,hash}` -> `{ok:true,synced?}` | `{ok:false,busy:true}` | `{ok:false,changed:true,hash,data}`
//! - `list {key}` -> `{ok:true,entries:[{entry,hash,data}]}`
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

const RESOLVE_NO_XDEV: u64 = 0x01;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;
const MAX_BYTES: usize = 64 << 20;
const RDONLY: i32 = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn fail(what: &str) -> String {
    format!("{what}: {}", std::io::Error::last_os_error())
}

fn os_err(what: &str, e: i32) -> String {
    format!("{what}: {}", std::io::Error::from_raw_os_error(e))
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "invalid name".to_string())
}

/// Opens `rel` beneath `root`, never following a link.
fn open_beneath(root: RawFd, rel: &str, flags: i32) -> Result<OwnedFd, i32> {
    let path = CString::new(rel).map_err(|_| libc::EINVAL)?;
    let how = OpenHow { flags: (flags | libc::O_CLOEXEC) as u64, mode: 0, resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV };
    // SAFETY: a valid dirfd, a NUL-terminated path and a correctly sized open_how for SYS_openat2.
    let fd = unsafe { libc::syscall(libc::SYS_openat2, root, path.as_ptr(), &how as *const OpenHow, std::mem::size_of::<OpenHow>()) };
    if fd < 0 {
        return Err(errno());
    }
    // SAFETY: the kernel returned a new, owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
}

/// Opens one plain entry of the private dir.
fn open_private(priv_fd: RawFd, entry: &str) -> Result<OwnedFd, i32> {
    let c = CString::new(entry).map_err(|_| libc::EINVAL)?;
    // SAFETY: openat on a held dirfd with a NUL-terminated single component.
    let fd = unsafe { libc::openat(priv_fd, c.as_ptr(), RDONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(errno());
    }
    // SAFETY: a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// A relative path's directory and file name; the name is one plain component.
fn split(rel: &str) -> Result<(String, String), String> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\0') {
        return Err("invalid path".into());
    }
    let (dir, name) = match rel.rsplit_once('/') {
        Some((d, n)) => (d.to_string(), n.to_string()),
        None => (".".to_string(), rel.to_string()),
    };
    if name.is_empty() || name == "." || name == ".." {
        return Err("invalid file name".into());
    }
    Ok((dir, name))
}

/// The admitted project root's path, as the bridge named it (argv, or the first hello): one per process.
static ROOT_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// A file's key, computed here from the admitted root and the request's path (never taken from the caller): the first
/// 16 hex characters of sha256(root NUL rel), as the bridge's keyOf. So a connection reaches only its own root's
/// entries (#412 finding 1). A publish's optional `txn` (hex) names its staged entry, for a lost reply.
fn key(req: &Value) -> Result<String, String> {
    let root = ROOT_PATH.get().ok_or("hello with the root first")?;
    let rel = req["path"].as_str().ok_or("path")?;
    split(rel)?;
    let mut input = root.as_bytes().to_vec();
    input.push(0);
    input.extend_from_slice(rel.as_bytes());
    Ok(hex(&input)[..16].to_string())
}

/// Serializes every operation on one file's private entries across all connections (#412 findings 1 and 3): a
/// `<key>-lock` file in the private dir, flocked for the operation (released when the fd closes, or the process dies).
/// A caller waits at most 25 s for another connection's operation, then gets an error: nothing done.
fn lock_key(priv_fd: RawFd, key: &str) -> Result<OwnedFd, String> {
    let c = cstr(&format!("{key}-lock"))?;
    // SAFETY: openat on the held private dir, one component, never following a link.
    let fd = unsafe { libc::openat(priv_fd, c.as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if fd < 0 {
        return Err(fail("lock"));
    }
    // SAFETY: a new owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    for _ in 0..1250 {
        // SAFETY: flock on our own fd.
        if unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(fd);
        }
        if errno() != libc::EWOULDBLOCK {
            return Err(fail("flock"));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err("another operation on this file is still in progress".into())
}

/// Transactions (#412 rounds 2 to 5). Each publish, before any change, creates `<key>.<txn>.txn`: an IMMUTABLE record
/// (our staged inode and the hash of the originating bridge's secret token), made atomically (an O_TMPFILE written,
/// flocked and fsynced, then linked: never visible partial or unlocked). Its outcome is a separate immutable
/// `<key>.<txn>.out` ("published" or "aborted"), made the same way and flushed again every time before anything
/// relies on it, so an interrupted or unflushed write is never trusted (round 5, astra 1 and 2).
/// A connection owns a transaction while it holds the record's flock. Keyed by the FULL identity `<key>.<txn>`, with
/// the one staged entry and its displaced inode.
type Owned = std::collections::HashMap<String, OwnedTxn>;

struct OwnedTxn {
    _record: OwnedFd,
    entry: String,
    ino: u64,
    /// Whether this connection published it (and so its bridge heard the reply), rather than claimed it later.
    heard: bool,
}

/// An orphan whose originating bridge's token is unknown may be recovered by anyone only after this long (#412
/// round 5): until then its retained bytes stay the originating bridge's, even across a reconnect.
const ORPHAN_SECS: i64 = 7 * 86_400;

/// Creates an immutable private file atomically: an unnamed file, written, fsynced, optionally flocked, then linked
/// under `name` (EEXIST if it exists) and the private dir fsynced. Returns its fd (holding the flock if asked).
fn create_immutable(priv_fd: RawFd, name: &str, content: &[u8], lock: bool, req: &Value) -> Result<OwnedFd, String> {
    let dot = CString::new(".").unwrap();
    // SAFETY: O_TMPFILE creates an unnamed file owned by the returned fd.
    let raw = unsafe { libc::openat(priv_fd, dot.as_ptr(), libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if raw < 0 {
        return Err(fail("O_TMPFILE"));
    }
    // SAFETY: a new owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: flock on our own fd.
    if lock && unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(fail("flock"));
    }
    // SAFETY: pwrite on our own fd.
    if unsafe { libc::pwrite(fd.as_raw_fd(), content.as_ptr().cast(), content.len(), 0) } != content.len() as isize || !fsync(fd.as_raw_fd()) {
        return Err(fail("write"));
    }
    test_pause(req, "beforeRecordLink");
    let c = cstr(name)?;
    let proc_path = CString::new(format!("/proc/self/fd/{}", fd.as_raw_fd())).unwrap();
    // SAFETY: links our unnamed, complete inode under a fresh private name; EEXIST if taken.
    if unsafe { libc::linkat(libc::AT_FDCWD, proc_path.as_ptr(), priv_fd, c.as_ptr(), libc::AT_SYMLINK_FOLLOW) } != 0 {
        return Err(fail("link"));
    }
    if test_fault(req, "recordSync") || !fsync(priv_fd) {
        return Err("the private dir cannot be flushed".into());
    }
    Ok(fd)
}

/// A private file's bytes: None only on ENOENT; any other failure is an error.
fn read_private(priv_fd: RawFd, name: &str) -> Result<Option<(OwnedFd, Vec<u8>)>, String> {
    let fd = match open_private(priv_fd, name) {
        Ok(fd) => fd,
        Err(libc::ENOENT) => return Ok(None),
        Err(e) => return Err(os_err("open", e)),
    };
    let bytes = read_all(&fd)?;
    Ok(Some((fd, bytes)))
}

/// A transaction's immutable record ({ino, ack}): None only when there is none.
fn record_info(priv_fd: RawFd, key: &str, txn: &str) -> Result<Option<Value>, String> {
    match read_private(priv_fd, &format!("{key}.{txn}.txn"))? {
        None => Ok(None),
        Some((_, bytes)) => serde_json::from_slice(&bytes).map(Some).map_err(|_| "the transaction record cannot be read".to_string()),
    }
}

/// A transaction's durable outcome, flushed again before it is trusted: None when no outcome exists yet.
fn outcome(priv_fd: RawFd, key: &str, txn: &str, req: &Value) -> Result<Option<String>, String> {
    let Some((fd, bytes)) = read_private(priv_fd, &format!("{key}.{txn}.out"))? else { return Ok(None) };
    if test_fault(req, "recordSync") || !fsync(fd.as_raw_fd()) || !fsync(priv_fd) {
        return Err("the transaction's outcome cannot be confirmed durable".into());
    }
    match std::str::from_utf8(&bytes) {
        Ok(state @ ("published" | "aborted")) => Ok(Some(state.to_string())),
        _ => Err("the transaction's outcome cannot be read".into()),
    }
}

/// The authoritative, durable outcome of an unowned transaction. An existing outcome is flushed again first. Otherwise
/// it is decided from the staged name (our inode: aborted; another inode: published; a complete scan that finds none:
/// aborted) and created immutably. Any failed observation or write is an error: the outcome stays unknown.
fn resolve(priv_fd: RawFd, key: &str, txn: &str, req: &Value) -> Result<String, String> {
    if let Some(state) = outcome(priv_fd, key, txn, req)? {
        return Ok(state);
    }
    let record = record_info(priv_fd, key, txn)?.ok_or("the transaction record is gone")?;
    let state = match staged_name(priv_fd, key, txn, req)? {
        None => "aborted",
        Some(name) => match stat_entry(priv_fd, &name)? {
            Some(st) if Some(st.st_ino as u64) != record["ino"].as_u64() => "published",
            Some(_) => "aborted",
            None => return Err("the staged entry changed during recovery".into()),
        },
    };
    if test_fault(req, "recordWrite") {
        return Err("the transaction's outcome cannot be recorded".into());
    }
    match create_immutable(priv_fd, &format!("{key}.{txn}.out"), state.as_bytes(), false, req) {
        Ok(_) => Ok(state.to_string()),
        // Another recovery linked it first: trust it only once it is confirmed durable.
        Err(_) => outcome(priv_fd, key, txn, req)?.ok_or_else(|| "the transaction's outcome cannot be recorded".to_string()),
    }
}

/// Removes a transaction's record and outcome (its data entry is gone and its bridge has settled or heard it).
fn retire(priv_fd: RawFd, key: &str, txn: &str) {
    for suffix in ["out", "txn"] {
        if let Ok(c) = cstr(&format!("{key}.{txn}.{suffix}")) {
            // SAFETY: unlinks one private file.
            unsafe { libc::unlinkat(priv_fd, c.as_ptr(), 0) };
        }
    }
    fsync(priv_fd);
}

/// The staged entry of a transaction, `<key>.<txn>-<unique>.staged`: None only when a complete scan finds none.
fn staged_name(priv_fd: RawFd, key: &str, txn: &str, req: &Value) -> Result<Option<String>, String> {
    if test_fault(req, "stagedScan") {
        return Err("the private dir cannot be scanned".into());
    }
    let prefix = format!("{key}.{txn}-");
    for e in std::fs::read_dir(format!("/proc/self/fd/{priv_fd}")).map_err(|e| e.to_string())? {
        let n = e.map_err(|e| e.to_string())?.file_name().to_string_lossy().into_owned();
        if n.starts_with(&prefix) && n.ends_with(".staged") {
            return Ok(Some(n));
        }
    }
    Ok(None)
}

/// A private entry's stat: None only when it does not exist (ENOENT); any other failure is an error.
fn stat_entry(priv_fd: RawFd, name: &str) -> Result<Option<libc::stat>, String> {
    let c = cstr(name)?;
    // SAFETY: fstatat on the held private dir, one component, without following a link.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(priv_fd, c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } == 0 {
        return Ok(Some(st));
    }
    match errno() {
        libc::ENOENT => Ok(None),
        e => Err(os_err("stat", e)),
    }
}

/// A staged entry's txn: `<key>.<txn>-<unique>.staged`.
fn txn_of(entry: &str, key: &str) -> Option<String> {
    let rest = entry.strip_prefix(key)?.strip_prefix('.')?;
    let (txn, _) = rest.split_once('-')?;
    txn.bytes().all(|b| b.is_ascii_hexdigit()).then(|| txn.to_string())
}

/// Takes a transaction's record lock: Some(fd), None while another live connection owns it, or Err (no record: ENOENT).
fn lock_record(priv_fd: RawFd, key: &str, txn: &str) -> Result<Option<OwnedFd>, i32> {
    let fd = open_private(priv_fd, &format!("{key}.{txn}.txn"))?;
    // SAFETY: flock on our own fd.
    if unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(fd));
    }
    match errno() {
        libc::EWOULDBLOCK => Ok(None),
        e => Err(e),
    }
}

/// Who may act on an unowned transaction's retained data (#412 round 5): its originating bridge (the secret token
/// matches the record's hash), anyone once it is an old orphan (ORPHAN_SECS), or anyone for a record with no token
/// (tests, and none written by the bridge).
fn may_recover(priv_fd: RawFd, key: &str, txn: &str, token: Option<&str>) -> Result<bool, String> {
    let Some(record) = record_info(priv_fd, key, txn)? else { return Ok(true) };
    let want = record["ack"].as_str().unwrap_or("");
    if want.is_empty() || token.is_some_and(|t| !t.is_empty() && hex(t.as_bytes()) == want) {
        return Ok(true);
    }
    let st = stat_entry(priv_fd, &format!("{key}.{txn}.txn"))?.ok_or("the transaction record is gone")?;
    Ok(now_secs() - st.st_ctime as i64 > ORPHAN_SECS)
}

/// Whether the connection that asked for this operation has closed (#412 finding 3): an operation that finds its
/// connection gone after taking the file's lock is abandoned before any change, so a later recovery of that file
/// (which waits for the lock) never races a publish nobody will hear about.
fn peer_gone() -> bool {
    let mut p = libc::pollfd { fd: 0, events: libc::POLLRDHUP, revents: 0 };
    // SAFETY: poll of one pollfd, without waiting.
    let ready = unsafe { libc::poll(&mut p, 1, 0) };
    ready > 0 && p.revents & (libc::POLLRDHUP | libc::POLLHUP | libc::POLLERR) != 0
}

/// The project root a connection names in its hello (#412 finding 1): it must belong to the account this helper
/// serves, and must be neither the private dir, inside it, nor one of its ancestors (compared by device and inode,
/// walking `..`), so no path beneath it (no links, no mount crossings) reaches the private dir.
fn admit_root(root_fd: RawFd, priv_fd: RawFd) -> Result<(), String> {
    let rst = fstat(root_fd)?;
    if PEER.get() != Some(&rst.st_uid) {
        return Err("the project root must belong to the account this helper serves".into());
    }
    let pst = fstat(priv_fd)?;
    // Whether `target` is `from` or one of its ancestors.
    let reaches = |from: RawFd, target: &libc::stat| -> Result<bool, String> {
        let dot = cstr(".")?;
        let up = cstr("..")?;
        // SAFETY: openat of "." on a valid dirfd, as O_PATH.
        let mut cur = unsafe { libc::openat(from, dot.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if cur < 0 {
            return Err(fail("walk"));
        }
        // SAFETY: owned from here.
        let mut cur_fd = unsafe { OwnedFd::from_raw_fd(cur) };
        for _ in 0..4096 {
            let st = fstat(cur_fd.as_raw_fd())?;
            if same(&st, target.st_ino as u64, target.st_dev as u64) {
                return Ok(true);
            }
            // SAFETY: openat of ".." on a held dirfd.
            cur = unsafe { libc::openat(cur_fd.as_raw_fd(), up.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) };
            if cur < 0 {
                return Err(fail("walk"));
            }
            // SAFETY: a new owned descriptor.
            let next = unsafe { OwnedFd::from_raw_fd(cur) };
            let nst = fstat(next.as_raw_fd())?;
            if same(&nst, st.st_ino as u64, st.st_dev as u64) {
                return Ok(false); // At "/".
            }
            cur_fd = next;
        }
        Err("the directory tree is too deep".into())
    };
    if reaches(root_fd, &pst)? {
        return Err("the project root is inside the helper's private directory".into());
    }
    if reaches(priv_fd, &rst)? {
        return Err("the project root contains the helper's private directory".into());
    }
    Ok(())
}

/// A private entry of `key`: `<key>.<rest>`, one component with no `/`.
fn entry(req: &Value) -> Result<String, String> {
    let k = key(req)?;
    let e = req["entry"].as_str().unwrap_or("");
    let rest = e.strip_prefix(k.as_str()).and_then(|r| r.strip_prefix('.')).unwrap_or("");
    if rest.is_empty() || e.contains('/') || e.contains('\0') || rest.starts_with('.') || !rest.ends_with(".staged") {
        return Err("invalid entry".into());
    }
    Ok(e.to_string())
}

fn fstat(fd: RawFd) -> Result<libc::stat, String> {
    // SAFETY: a zeroed stat filled by fstat on a valid fd.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return Err(fail("fstat"));
    }
    Ok(st)
}

fn fstatat(dir: RawFd, name: &str) -> Option<libc::stat> {
    let c = CString::new(name).ok()?;
    // SAFETY: as fstat; AT_SYMLINK_NOFOLLOW looks at the entry itself.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::fstatat(dir, c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } == 0).then_some(st)
}

fn is_reg(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFREG
}

fn read_all(fd: &OwnedFd) -> Result<Vec<u8>, String> {
    // SAFETY: a duplicate so the File's drop does not close the caller's fd.
    let dup = unsafe { libc::dup(fd.as_raw_fd()) };
    if dup < 0 {
        return Err(fail("dup"));
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(dup) };
    let mut out = Vec::new();
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    Read::take(&mut file, MAX_BYTES as u64 + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
    if out.len() > MAX_BYTES {
        return Err("file too large".into());
    }
    Ok(out)
}

fn fsync(fd: RawFd) -> bool {
    // SAFETY: fsync on a valid fd.
    unsafe { libc::fsync(fd) == 0 }
}

fn unique() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, NEXT.fetch_add(1, Ordering::Relaxed))
}

fn testing() -> bool {
    std::env::var_os("COEDIT_FS_TEST").is_some()
}

/// Tests only (COEDIT_FS_TEST=1): waits `pauseMs` at `point`, so a test can act in that window.
fn test_pause(req: &Value, point: &str) {
    if testing() && req["pause"].as_str() == Some(point) {
        std::thread::sleep(std::time::Duration::from_millis(req["pauseMs"].as_u64().unwrap_or(0).min(10_000)));
    }
}

/// Tests only: the step `point` fails as with EIO.
fn test_fault(req: &Value, point: &str) -> bool {
    testing() && req["fault"].as_str() == Some(point)
}

fn hex(bytes: &[u8]) -> String {
    <Sha256 as Digest>::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn same(st: &libc::stat, ino: u64, dev: u64) -> bool {
    st.st_ino as u64 == ino && st.st_dev as u64 == dev
}

/// The names in a NULL-terminated C string array (a group's members).
fn c_names(mut p: *mut *mut libc::c_char) -> Vec<String> {
    let mut out = Vec::new();
    // SAFETY: walks a NULL-terminated array of C strings from getgrgid.
    unsafe {
        while !p.is_null() && !(*p).is_null() {
            out.push(std::ffi::CStr::from_ptr(*p).to_string_lossy().into_owned());
            p = p.add(1);
        }
    }
    out
}

/// The accounts admission trusts (smartyfs#32): the helper itself, the one account it serves (its peer), and root.
/// Anyone else who could move a directory on a file's path makes a publish refused.
static PEER: std::sync::OnceLock<libc::uid_t> = std::sync::OnceLock::new();

fn trusted(uid: libc::uid_t) -> bool {
    // SAFETY: geteuid cannot fail.
    uid == 0 || uid == unsafe { libc::geteuid() } || PEER.get() == Some(&uid)
}

/// An account's name and primary group, or None.
fn account(uid: libc::uid_t) -> Option<(String, libc::gid_t)> {
    // SAFETY: the helper is single-threaded, so the non-reentrant getpwuid is safe; its result is copied at once.
    unsafe {
        let pw = libc::getpwuid(uid);
        (!pw.is_null()).then(|| (std::ffi::CStr::from_ptr((*pw).pw_name).to_string_lossy().into_owned(), (*pw).pw_gid))
    }
}

/// Whether `gid` is a private group of the trusted accounts: the primary group of the helper or of its peer, with no
/// member but trusted accounts and no other account's primary group. Anything else (a shared group, or one we cannot
/// read) counts as other accounts. Tests only: `testGroupMembers`.
fn private_group(gid: libc::gid_t, req: &Value) -> bool {
    // SAFETY: getegid cannot fail.
    let egid = unsafe { libc::getegid() };
    let peer = PEER.get().and_then(|&uid| account(uid));
    if gid != egid && peer.as_ref().map(|p| p.1) != Some(gid) {
        return false;
    }
    // SAFETY: geteuid cannot fail.
    let Some((me, _)) = account(unsafe { libc::geteuid() }) else { return false };
    let names: Vec<String> = [Some(me), peer.map(|p| p.0)].into_iter().flatten().collect();
    let mut members = unsafe {
        let gr = libc::getgrgid(gid);
        if gr.is_null() {
            return false;
        }
        c_names((*gr).gr_mem)
    };
    if let (true, Some(list)) = (testing(), req["testGroupMembers"].as_array()) {
        members = list.iter().filter_map(|m| m.as_str().map(String::from)).collect();
    }
    if members.iter().any(|m| !names.contains(m)) {
        return false;
    }
    let mut shared = false;
    unsafe {
        libc::setpwent();
        loop {
            let pw = libc::getpwent();
            if pw.is_null() {
                break;
            }
            if (*pw).pw_gid == gid && !trusted((*pw).pw_uid) {
                shared = true;
                break;
            }
        }
        libc::endpwent();
    }
    !shared
}

/// Whether another account could rename a directory on the way from the root to `dir_rel` (and so move the file's
/// directory out of the project mid-save). For each directory from the root down to that directory's parent:
/// another account (not root) owns it; or others can write to it (other bits, or group bits of a group that is not
/// our private group) and it is not sticky; or it is sticky and the child on our path is another account's.
fn movable_by_others(root: RawFd, dir_rel: &str, req: &Value) -> Result<bool, String> {
    if dir_rel == "." {
        return Ok(false);
    }
    // Tests only: `testOwners: {path: uid}` stands in for another account's directory.
    let owner = |path: &str, st: &libc::stat| -> u32 {
        match (testing(), req["testOwners"][path].as_u64()) {
            (true, Some(uid)) => uid as u32,
            _ => st.st_uid,
        }
    };
    let foreign = |uid: u32| !trusted(uid);
    let stat_at = |p: &str| -> Result<libc::stat, String> {
        let fd = open_beneath(root, p, libc::O_PATH | libc::O_DIRECTORY).map_err(|e| os_err("directory", e))?;
        fstat(fd.as_raw_fd())
    };
    let parts: Vec<&str> = dir_rel.split('/').collect();
    for i in 0..parts.len() {
        let p = if i == 0 { ".".to_string() } else { parts[..i].join("/") };
        let fd = open_beneath(root, &p, libc::O_PATH | libc::O_DIRECTORY).map_err(|e| os_err("directory", e))?;
        // An extended access ACL can grant a named account write access that the mode bits (then the ACL mask) hide:
        // allowed only when every named entry that can write is a trusted account or a private group.
        if let Some(acl) = xattr(fd.as_raw_fd(), ACCESS_ACL)? {
            if !acl_trusted(&acl, req) {
                return Err("a directory on the file's path has an extended ACL".into());
            }
        }
        let st = fstat(fd.as_raw_fd())?;
        if foreign(owner(&p, &st)) {
            return Ok(true);
        }
        let mode = st.st_mode;
        if mode & 0o002 != 0 || (mode & 0o020 != 0 && !private_group(st.st_gid, req)) {
            if mode & libc::S_ISVTX == 0 {
                return Ok(true);
            }
            // Sticky: the owner of the child on our path may still rename it.
            let child = parts[..=i].join("/");
            if foreign(owner(&child, &stat_at(&child)?)) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

const ACCESS_ACL: &str = "system.posix_acl_access";
const DEFAULT_ACL: &str = "system.posix_acl_default";

/// An xattr of the object held by `fd` (an O_PATH fd works, through its /proc link), or None when it has none.
fn xattr(fd: RawFd, name: &str) -> Result<Option<Vec<u8>>, String> {
    let p = CString::new(format!("/proc/self/fd/{fd}")).unwrap();
    let n = cstr(name)?;
    let mut buf = vec![0u8; 4096];
    // SAFETY: getxattr into a buffer of the given size; the /proc link names our own open object.
    let len = unsafe { libc::getxattr(p.as_ptr(), n.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
    if len < 0 {
        let e = errno();
        return if e == libc::ENODATA || e == libc::EOPNOTSUPP { Ok(None) } else { Err(os_err("getxattr", e)) };
    }
    buf.truncate(len as usize);
    Ok(Some(buf))
}

const ACL_USER_OBJ: u16 = 0x01;
const ACL_USER: u16 = 0x02;
const ACL_GROUP_OBJ: u16 = 0x04;
const ACL_GROUP: u16 = 0x08;
const ACL_MASK: u16 = 0x10;
const ACL_OTHER: u16 = 0x20;

/// A POSIX ACL xattr's entries (acl(5): a version-2 header, then tag, perm, id), or None when malformed.
fn acl_entries(acl: &[u8]) -> Option<Vec<(u16, u16, u32)>> {
    if acl.len() < 4 || u32::from_le_bytes(acl[..4].try_into().ok()?) != 2 || (acl.len() - 4) % 8 != 0 {
        return None;
    }
    Some(acl[4..].chunks(8).map(|e| (u16::from_le_bytes([e[0], e[1]]), u16::from_le_bytes([e[2], e[3]]), u32::from_le_bytes([e[4], e[5], e[6], e[7]]))).collect())
}

fn acl_bytes(entries: &[(u16, u16, u32)]) -> Vec<u8> {
    let mut out = 2u32.to_le_bytes().to_vec();
    for (tag, perm, id) in entries {
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&perm.to_le_bytes());
        out.extend_from_slice(&id.to_le_bytes());
    }
    out
}

/// Whether every named entry of a directory's ACL that grants write is a trusted account or a private group.
fn acl_trusted(acl: &[u8], req: &Value) -> bool {
    acl_entries(acl).is_some_and(|entries| {
        entries.iter().all(|&(tag, perm, id)| {
            perm & 2 == 0 || match tag {
                ACL_USER => trusted(id),
                ACL_GROUP => private_group(id, req),
                _ => true,
            }
        })
    })
}

/// The access ACL that gives a file we publish over another owner's file (smartyfs#32: the helper runs as its own
/// account, and cannot give it away) exactly the EFFECTIVE access every principal had (#412 finding 2), per acl(5):
/// - the original owner was not subject to the mask: it becomes a named user with exactly its owner permissions
///   (a named entry the original had for that uid was shadowed by the owner entry, so it is dropped);
/// - every other named user and group, and the original owning group (now a named group), keep their permissions
///   AFTER the original mask, so widening the new mask for the owner never re-enables a bit the old mask removed;
/// - our own owning group gets nothing; the mask is the union of the group-class entries; other is kept.
fn equivalent_acl(original: Option<&[u8]>, owner: u32, group: u32, mode: u32) -> Option<Vec<u8>> {
    let bits = |shift: u32| ((mode >> shift) & 7) as u16;
    let (mut owner_perm, mut group_perm, mut other_perm) = (bits(6), bits(3), bits(0));
    let mut mask = 7u16;
    let mut named: Vec<(u16, u16, u32)> = Vec::new();
    if let Some(acl) = original {
        for (tag, perm, id) in acl_entries(acl)? {
            match tag {
                ACL_USER_OBJ => owner_perm = perm,
                ACL_GROUP_OBJ => group_perm = perm,
                ACL_OTHER => other_perm = perm,
                ACL_MASK => mask = perm,
                ACL_USER | ACL_GROUP => named.push((tag, perm, id)),
                _ => return None, // An entry we do not understand: refuse rather than guess.
            }
        }
    }
    // With an ACL, st_mode's group bits ARE the mask: the owning group's own permission came from the ACL above.
    let mut entries: Vec<(u16, u16, u32)> = named
        .into_iter()
        .filter(|&(tag, _, id)| !(tag == ACL_USER && id == owner))
        .map(|(tag, perm, id)| (tag, perm & mask, id))
        .collect();
    let mut add = |tag: u16, perm: u16, id: u32| match entries.iter_mut().find(|e| e.0 == tag && e.2 == id) {
        Some(e) => e.1 |= perm, // A named entry for the owning group too: a member matched both, so the union.
        None => entries.push((tag, perm, id)),
    };
    add(ACL_GROUP, group_perm & mask, group);
    entries.push((ACL_USER, owner_perm, owner));
    entries.sort_by_key(|e| (e.0, e.2));
    let union = entries.iter().fold(0, |m, e| m | e.1);
    let mut out = vec![(ACL_USER_OBJ, owner_perm, u32::MAX)];
    out.extend(entries.iter().filter(|e| e.0 == ACL_USER));
    out.push((ACL_GROUP_OBJ, 0, u32::MAX));
    out.extend(entries.iter().filter(|e| e.0 == ACL_GROUP));
    out.push((ACL_MASK, union, u32::MAX));
    out.push((ACL_OTHER, other_perm, u32::MAX));
    Some(acl_bytes(&out))
}

fn read_op(root: RawFd, req: &Value) -> Result<Value, String> {
    let rel = req["path"].as_str().ok_or("path")?;
    split(rel)?;
    let fd = match open_beneath(root, rel, RDONLY) {
        Ok(fd) => fd,
        Err(libc::ENOENT) => return Ok(json!({"ok": false, "conflict": "gone"})),
        Err(e) => return Err(os_err("open", e)),
    };
    let st = fstat(fd.as_raw_fd())?;
    if !is_reg(&st) {
        return Err("not a regular file".into());
    }
    let bytes = read_all(&fd)?;
    Ok(json!({"ok": true, "ino": st.st_ino as u64, "dev": st.st_dev as u64, "hash": hex(&bytes), "data": B64.encode(&bytes)}))
}

/// The directories of publishes whose flush failed, by their displaced entry: a later `flush` syncs the directory we
/// published into, even if it has since moved (smartyfs#34 item 2).
type Unsynced = std::collections::HashMap<String, OwnedFd>;

fn publish_op(root: RawFd, priv_fd: RawFd, req: &Value, unsynced: &mut Unsynced, owned: &mut Owned) -> Result<Value, String> {
    let rel = req["path"].as_str().ok_or("path")?;
    let (dir_rel, name) = split(rel)?;
    let key = key(req)?;
    let (ino, dev) = (req["ino"].as_u64().ok_or("ino")?, req["dev"].as_u64().ok_or("dev")?);
    let hash = req["hash"].as_str().ok_or("hash")?;
    let data = B64.decode(req["data"].as_str().ok_or("data")?).map_err(|_| "data")?;
    if data.len() > MAX_BYTES {
        return Err("data too large".into());
    }
    let _lock = lock_key(priv_fd, &key)?;
    if peer_gone() {
        return Err("the connection closed: nothing published".into());
    }
    test_pause(req, "beforeOpen");
    // 1. The directory, fsync-able, and where it is now.
    let dir = open_beneath(root, &dir_rel, libc::O_RDONLY | libc::O_DIRECTORY).map_err(|e| os_err("directory", e))?;
    let d = dir.as_raw_fd();
    let dir_st = fstat(d)?;
    if dir_st.st_dev != fstat(priv_fd)?.st_dev {
        return Err("the recovery directory must be on the project's filesystem".into());
    }
    // Another account could move the directory out of the root between here and the exchange: refused.
    if movable_by_others(root, &dir_rel, req)? {
        return Err("a directory on the file's path is one others can write to".into());
    }
    // 2. The revision being replaced: the checked inode, with the checked bytes.
    let current = match open_beneath(root, rel, RDONLY) {
        Ok(fd) => fd,
        Err(libc::ENOENT) => return Ok(json!({"ok": false, "conflict": "gone"})),
        Err(e) => return Err(os_err("open", e)),
    };
    let st = fstat(current.as_raw_fd())?;
    if !is_reg(&st) {
        return Err("not a regular file".into());
    }
    if !same(&st, ino, dev) || hex(&read_all(&current)?) != hash {
        return Ok(json!({"ok": false, "conflict": "changed"}));
    }
    let acl = xattr(current.as_raw_fd(), ACCESS_ACL)?;
    drop(current);
    // 3. Staging: an unnamed file in the private dir; chmod, then fsync, then read back.
    let dot = CString::new(".").unwrap();
    // SAFETY: O_TMPFILE creates an unnamed file owned by the returned fd.
    let tmp = unsafe { libc::openat(priv_fd, dot.as_ptr(), libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if tmp < 0 {
        return Err(fail("O_TMPFILE"));
    }
    // SAFETY: a new owned descriptor.
    let tmp = unsafe { OwnedFd::from_raw_fd(tmp) };
    {
        // SAFETY: a dup, so the File's drop leaves `tmp` open.
        let dup = unsafe { libc::dup(tmp.as_raw_fd()) };
        if dup < 0 {
            return Err(fail("dup"));
        }
        let mut file = unsafe { std::fs::File::from_raw_fd(dup) };
        file.write_all(&data).map_err(|e| e.to_string())?;
    }
    // Tests only: `testFileOwner` stands in for a file of the account we serve.
    let file_owner = match (testing(), req["testFileOwner"].as_u64()) {
        (true, Some(uid)) => uid as u32,
        _ => st.st_uid,
    };
    // SAFETY: geteuid cannot fail.
    if file_owner != unsafe { libc::geteuid() } {
        // Another account's file (the one we serve, smartyfs#32): ours cannot be given to it, or to its group, without
        // CAP_CHOWN (not granted). It keeps the same access instead: the mode (without set-user/group-ID), then an ACL
        // that names the original owner and group with their permissions. Setting it sets the mode's group bits to
        // the mask. The owner of the published file is this helper's account.
        // SAFETY: fchmod on our fd.
        if unsafe { libc::fchmod(tmp.as_raw_fd(), st.st_mode & 0o1777) } != 0 {
            return Err(fail("fchmod"));
        }
        let eq = equivalent_acl(acl.as_deref(), file_owner, st.st_gid, st.st_mode).ok_or("the file's ACL cannot be read")?;
        let n = cstr(ACCESS_ACL)?;
        // SAFETY: sets the ACL on our own fd.
        if unsafe { libc::fsetxattr(tmp.as_raw_fd(), n.as_ptr(), eq.as_ptr().cast(), eq.len(), 0) } != 0 {
            return Err(fail("the file's access cannot be kept (ACL)"));
        }
    } else {
        // Our own file: it takes the original's group and access ACL, never our own group (smartyfs#34 item 13).
        // SAFETY: fchown of our own fd to a group; -1 keeps the owner.
        if unsafe { libc::fchown(tmp.as_raw_fd(), u32::MAX, st.st_gid) } != 0 {
            return Err(fail("the file's group cannot be kept (fchown)"));
        }
        if let Some(acl) = &acl {
            let n = cstr(ACCESS_ACL)?;
            // SAFETY: sets the copied ACL on our own fd.
            if unsafe { libc::fsetxattr(tmp.as_raw_fd(), n.as_ptr(), acl.as_ptr().cast(), acl.len(), 0) } != 0 {
                return Err(fail("the file's ACL cannot be kept"));
            }
        }
        // The mode, without set-user-ID or set-group-ID: our file must not run as us (item 11). After the ACL, so the
        // mask follows the original's group bits.
        // SAFETY: fchmod on our fd.
        if unsafe { libc::fchmod(tmp.as_raw_fd(), st.st_mode & 0o1777) } != 0 {
            return Err(fail("fchmod"));
        }
    }
    if !fsync(tmp.as_raw_fd()) {
        return Err(fail("fsync staging"));
    }
    if read_all(&tmp)? != data {
        return Err("staging bytes differ from the intended bytes".into());
    }
    let ours = fstat(tmp.as_raw_fd())?;
    // 4. Named in the private dir only.
    let txn = match req["txn"].as_str() {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => hex(unique().as_bytes())[..12].to_string(),
    };
    if txn.len() > 32 || !txn.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("invalid txn".into());
    }
    // Only the originating bridge knows the token behind this hash: acknowledgement needs it (#412 round 4, finding 1).
    let ack_hash = req["ack"].as_str().unwrap_or("").to_string();
    if ack_hash.len() > 64 || !ack_hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("invalid ack".into());
    }
    // The transaction record, before any change (#412 round 3): created exclusively, locked by this connection, and
    // durable with our staged inode, so the outcome can always be decided from it. Without it, nothing is published.
    let record_c = cstr(&format!("{key}.{txn}.txn"))?;
    // SAFETY: removes our own record (nothing was published).
    let drop_record = || unsafe { libc::unlinkat(priv_fd, record_c.as_ptr(), 0) };
    let record_bytes = json!({"ino": ours.st_ino as u64, "ack": ack_hash}).to_string();
    let record = match create_immutable(priv_fd, &format!("{key}.{txn}.txn"), record_bytes.as_bytes(), true, req) {
        Ok(fd) => fd,
        Err(e) => {
            if !e.starts_with("link") {
                drop_record(); // Linked but not flushed: ours (the file's lock is held), so it goes.
            }
            return Err(format!("the transaction record cannot be established ({e}): nothing published"));
        }
    };
    let staged = format!("{key}.{txn}-{}.staged", unique());
    let staged_c = cstr(&staged)?;
    let proc_path = CString::new(format!("/proc/self/fd/{}", tmp.as_raw_fd())).unwrap();
    // SAFETY: links our unnamed inode (through its fd) under a fresh private name; EEXIST if taken.
    if unsafe { libc::linkat(libc::AT_FDCWD, proc_path.as_ptr(), priv_fd, staged_c.as_ptr(), libc::AT_SYMLINK_FOLLOW) } != 0 {
        drop_record();
        return Err(fail("linkat"));
    }
    // SAFETY: unlinks our own private entry and record (nothing was published).
    let unlink_staged = || unsafe {
        libc::unlinkat(priv_fd, staged_c.as_ptr(), 0);
        libc::unlinkat(priv_fd, record_c.as_ptr(), 0)
    };
    if !fsync(priv_fd) {
        unlink_staged();
        return Err(fail("fsync private dir"));
    }
    test_pause(req, "beforeExchange");
    if peer_gone() {
        unlink_staged();
        return Err("the connection closed: nothing published".into());
    }
    // 6. The one change in the project.
    let name_c = cstr(&name)?;
    // SAFETY: valid dirfds and names; RENAME_EXCHANGE swaps both entries atomically, or fails.
    let r = unsafe { libc::syscall(libc::SYS_renameat2, priv_fd, staged_c.as_ptr(), d, name_c.as_ptr(), libc::RENAME_EXCHANGE) };
    if r != 0 {
        let e = errno();
        unlink_staged();
        if e == libc::ENOENT {
            return Ok(json!({"ok": false, "conflict": "gone"}));
        }
        return Err(os_err("renameat2", e));
    }
    // 7. Published: from here the private entry holds the displaced object, and nothing is undone. The record says so
    // (if this write fails, a recovery still decides it from the staged inode).
    test_pause(req, "afterExchange");
    // The outcome, as its own immutable file (if this fails, a recovery decides it from the staged inode).
    let _ = create_immutable(priv_fd, &format!("{key}.{txn}.out"), b"published", false, req);
    let mut uncertain: Option<&str> = None;
    if test_fault(req, "afterExchange") {
        uncertain = Some("observation");
    }
    // 9. Durability: the target dir, then the private dir. Reported on its own: a cached read proves no flush.
    let synced = !test_fault(req, "dirSync") && fsync(d) && fsync(priv_fd);
    // 10. Observe. Containment first: an escaped directory is uncertain, whatever else happened to the file.
    let still = open_beneath(root, &dir_rel, libc::O_PATH | libc::O_DIRECTORY)
        .ok()
        .and_then(|f| fstat(f.as_raw_fd()).ok())
        .map(|s| same(&s, dir_st.st_ino as u64, dir_st.st_dev as u64))
        .unwrap_or(false);
    if !still {
        uncertain = uncertain.or(Some("escaped"));
    }
    if !fstatat(d, &name).map(|s| same(&s, ours.st_ino as u64, ours.st_dev as u64)).unwrap_or(false) {
        uncertain = uncertain.or(Some("replaced"));
    }
    match read_all(&tmp) {
        Ok(b) if b == data => {}
        Ok(_) => uncertain = uncertain.or(Some("bytes")),
        Err(_) => uncertain = uncertain.or(Some("observation")),
    }
    let checked = match open_private(priv_fd, &staged) {
        Ok(fd) => match fstat(fd.as_raw_fd()) {
            Ok(s) if is_reg(&s) && same(&s, ino, dev) => match read_all(&fd) {
                Ok(b) => hex(&b) == hash,
                Err(_) => {
                    uncertain = uncertain.or(Some("observation"));
                    true
                }
            },
            Ok(_) => false,
            Err(_) => {
                uncertain = uncertain.or(Some("observation"));
                true
            }
        },
        // A symlink or FIFO put at the target before the exchange: not the checked revision.
        Err(libc::ELOOP) | Err(libc::ENXIO) => false,
        Err(_) => {
            uncertain = uncertain.or(Some("observation"));
            true
        }
    };
    if !synced {
        unsynced.insert(staged.clone(), dir);
    }
    // This connection owns the transaction (its locked record) until its own dispose of the displaced entry.
    let displaced_ino = fstatat(priv_fd, &staged).map(|st| st.st_ino as u64).unwrap_or(0);
    owned.insert(format!("{key}.{txn}"), OwnedTxn { _record: record, entry: staged.clone(), ino: displaced_ino, heard: true });
    // 11. Reply.
    Ok(match uncertain {
        Some(u) => json!({"ok": false, "published": true, "synced": synced, "uncertain": u, "displaced": staged}),
        None if !checked => json!({"ok": false, "published": true, "synced": synced, "conflict": "raced", "displaced": staged}),
        None => json!({"ok": synced, "published": true, "synced": synced, "ino": ours.st_ino as u64, "dev": ours.st_dev as u64, "displaced": staged}),
    })
}

/// Completes a publish's durability after a failed directory fsync: the directory it published into (held since, by
/// its displaced `entry`; else the file's directory now), then the private dir. `ino` is the directory synced.
fn flush_op(root: RawFd, priv_fd: RawFd, req: &Value, unsynced: &mut Unsynced) -> Result<Value, String> {
    let rel = req["path"].as_str().ok_or("path")?;
    let (dir_rel, _) = split(rel)?;
    let entry = req["entry"].as_str().unwrap_or("").to_string();
    let _lock = lock_key(priv_fd, &key(req)?)?;
    let opened;
    let d = match unsynced.get(&entry) {
        Some(fd) => fd.as_raw_fd(),
        None => {
            opened = open_beneath(root, &dir_rel, libc::O_RDONLY | libc::O_DIRECTORY).map_err(|e| os_err("directory", e))?;
            opened.as_raw_fd()
        }
    };
    let ino = fstat(d)?.st_ino as u64;
    let synced = !test_fault(req, "dirSync") && fsync(d) && !test_fault(req, "privSync") && fsync(priv_fd);
    if !synced {
        return Ok(json!({"ok": false, "synced": false}));
    }
    unsynced.remove(&entry);
    Ok(json!({"ok": true, "ino": ino}))
}

fn dispose_op(priv_fd: RawFd, req: &Value, owned: &mut Owned) -> Result<Value, String> {
    let entry = entry(req)?;
    let key = key(req)?;
    let _lock = lock_key(priv_fd, &key)?;
    let hash = req["hash"].as_str().ok_or("hash")?;
    // An entry from before transaction records (no txn in its name) has no owner to ask: an orphan.
    let Some(txn) = txn_of(&entry, &key) else {
        return dispose_named(priv_fd, req, &entry, hash);
    };
    // Its transaction: ours (held since our publish, or claimed below with its token), another live connection's
    // (refused, never touched), or unowned: then only its originating bridge's token, or orphan age, may act on it
    // (#412 round 5: a lost helper does not hand a live bridge's retained bytes to anyone).
    let id = format!("{key}.{txn}");
    if !owned.contains_key(&id) {
        let token = req["token"].as_str();
        let lock = match lock_record(priv_fd, &key, &txn) {
            Ok(Some(fd)) => Some(fd),
            Ok(None) => return Ok(json!({"ok": false, "owned": true})),
            Err(libc::ENOENT) => None, // No record: an entry from before records, or one aged out.
            Err(e) => return Err(os_err("the transaction record", e)),
        };
        if let Some(fd) = lock {
            if !may_recover(priv_fd, &key, &txn, token)? {
                return Ok(json!({"ok": false, "owned": true}));
            }
            // The outcome is durable before the evidence it was derived from may go; otherwise nothing is removed.
            resolve(priv_fd, &key, &txn, req)?;
            let ino = stat_entry(priv_fd, &entry)?.map(|st| st.st_ino as u64).unwrap_or(0);
            owned.insert(id.clone(), OwnedTxn { _record: fd, entry: entry.clone(), ino, heard: false });
        } else {
            return dispose_named(priv_fd, req, &entry, hash);
        }
    }
    let mine = owned.remove(&id).ok_or("lost ownership")?;
    // The owner acts only on exactly the entry its transaction produced, still holding that displaced inode.
    let genuine = entry == mine.entry && matches!(stat_entry(priv_fd, &entry), Ok(Some(st)) if st.st_ino as u64 == mine.ino);
    if !genuine {
        owned.insert(id, mine);
        return Ok(json!({"ok": false, "error": "not this transaction's entry"}));
    }
    let done = dispose_named(priv_fd, req, &entry, hash);
    if matches!(&done, Ok(v) if v["ok"] == true) {
        // Its data is gone. Retired only by the connection that published it (its bridge heard the reply); after a
        // claim, the outcome stays for the originating bridge until it acks (#412 round 5).
        if mine.heard {
            retire(priv_fd, &key, &txn);
        }
    } else {
        owned.insert(id, mine); // Still pending (busy, late bytes, an error): this connection keeps owning it.
    }
    done
}

/// Disposes a private entry by name; one already gone is ok.
fn dispose_named(priv_fd: RawFd, req: &Value, entry: &str, hash: &str) -> Result<Value, String> {
    match open_private(priv_fd, entry) {
        Ok(fd) => dispose_entry(priv_fd, req, entry, hash, &fd),
        Err(libc::ENOENT) => Ok(json!({"ok": true})),
        Err(e) => Err(os_err("open", e)),
    }
}

/// `ack {path, txn}`: the originating bridge has settled a transaction whose reply it lost, so its record may go. A
/// record still locked by a live connection is left alone.
fn ack_op(priv_fd: RawFd, req: &Value) -> Result<Value, String> {
    let key = key(req)?;
    let txn = req["txn"].as_str().ok_or("txn")?;
    if txn.is_empty() || txn.len() > 32 || !txn.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("invalid txn".into());
    }
    let token = req["token"].as_str().unwrap_or("");
    let _lock = lock_key(priv_fd, &key)?;
    match lock_record(priv_fd, &key, txn) {
        Ok(Some(_fd)) => {
            // Only the originating bridge's secret token may remove the receipt; the txn in `list` grants nothing.
            let record = record_info(priv_fd, &key, txn)?.ok_or("the transaction record is gone")?;
            let want = record["ack"].as_str().unwrap_or("");
            if token.is_empty() || want.is_empty() || hex(token.as_bytes()) != want {
                return Ok(json!({"ok": false, "error": "not this transaction's owner"}));
            }
            // Its retained data is still there: the record keeps guarding it until that data is disposed (#412 r5).
            if staged_name(priv_fd, &key, txn, req)?.is_some() {
                return Ok(json!({"ok": true, "pending": true}));
            }
            retire(priv_fd, &key, txn);
            Ok(json!({"ok": true}))
        }
        Ok(None) => Ok(json!({"ok": false, "owned": true})),
        Err(libc::ENOENT) => Ok(json!({"ok": true})),
        Err(e) => Err(os_err("the transaction record", e)),
    }
}

fn dispose_entry(priv_fd: RawFd, req: &Value, entry: &str, hash: &str, fd: &OwnedFd) -> Result<Value, String> {
    if !is_reg(&fstat(fd.as_raw_fd())?) {
        return Err("not a regular file".into());
    }
    // A read lease is refused while any process has the file open for writing (EAGAIN): it stays, and is tried later.
    // Any other refusal is permanent, never "busy" (#412 finding 4): EPERM when the inode is another account's and
    // CAP_LEASE was not granted (the service's unit grants it). The entry stays; nothing is unlinked unleased.
    // SAFETY: fcntl lease calls on our own fd.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETLEASE, libc::F_RDLCK) } != 0 {
        let e = errno();
        if e == libc::EAGAIN {
            return Ok(json!({"ok": false, "busy": true}));
        }
        return Err(os_err("the displaced revision cannot be leased (the service needs CAP_LEASE)", e));
    }
    // Under the lease a writer's open waits for our unlock, so these bytes are final.
    let unlock = || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETLEASE, libc::F_UNLCK) };
    let bytes = match read_all(&fd) {
        Ok(b) => b,
        Err(e) => {
            unlock();
            return Err(e);
        }
    };
    if hex(&bytes) != hash {
        unlock();
        return Ok(json!({"ok": false, "changed": true, "hash": hex(&bytes), "data": B64.encode(&bytes)}));
    }
    let c = cstr(entry)?;
    // SAFETY: unlinks one entry of the private dir.
    if unsafe { libc::unlinkat(priv_fd, c.as_ptr(), 0) } != 0 {
        let err = fail("unlinkat");
        unlock();
        return Err(err);
    }
    let synced = !test_fault(req, "privSync") && fsync(priv_fd);
    unlock();
    Ok(if synced { json!({"ok": true}) } else { json!({"ok": true, "synced": false}) })
}

fn list_op(priv_fd: RawFd, req: &Value, owned: &Owned) -> Result<Value, String> {
    let key = key(req)?;
    // Waits for any operation on this file by another connection: a live transaction is never listed as a leftover.
    let _lock = lock_key(priv_fd, &key)?;
    let prefix = format!("{key}.");
    // A scan error fails the whole list (the bridge holds): a partial scan could hide a record or an entry.
    let mut names: Vec<String> = Vec::new();
    for e in std::fs::read_dir(format!("/proc/self/fd/{priv_fd}")).map_err(|e| e.to_string())? {
        let n = e.map_err(|e| e.to_string())?.file_name().to_string_lossy().into_owned();
        if n.starts_with(&prefix) {
            names.push(n);
        }
    }
    // Transaction records (#412 rounds 3 to 5): each with its authoritative outcome, and whether this caller may act
    // on its retained data. A live connection's is `owned`; an unowned one is `owned` too unless the caller shows its
    // originating bridge's token (in `tokens`) or it is an old orphan. Outcomes are never omitted: unknown if
    // unreadable. A record goes once no data is left: on its owner's dispose, its bridge's ack, or after 30 days.
    let tokens = &req["tokens"];
    let mut records = Vec::new();
    let mut guarded = std::collections::HashSet::new();
    for name in names.iter().filter(|n| n.ends_with(".txn")) {
        let txn = name[prefix.len()..name.len() - 4].to_string();
        if owned.contains_key(&format!("{key}.{txn}")) {
            records.push(json!({"txn": txn, "state": "owned-here"}));
            continue;
        }
        match lock_record(priv_fd, &key, &txn) {
            Ok(Some(fd)) => {
                let has_data = staged_name(priv_fd, &key, &txn, req).map(|n| n.is_some()).unwrap_or(true);
                let old = fstat(fd.as_raw_fd()).map(|st| now_secs() - st.st_ctime as i64 > 30 * 86_400).unwrap_or(false);
                if old && !has_data {
                    retire(priv_fd, &key, &txn);
                    continue;
                }
                let state = resolve(priv_fd, &key, &txn, req).map(|s| json!(s)).unwrap_or(json!("unknown"));
                if may_recover(priv_fd, &key, &txn, tokens[txn.as_str()].as_str()).unwrap_or(false) {
                    records.push(json!({"txn": txn, "state": state}));
                } else {
                    guarded.insert(txn.clone());
                    records.push(json!({"txn": txn, "state": state, "owned": true}));
                }
            }
            Ok(None) => {
                guarded.insert(txn.clone());
                records.push(json!({"txn": txn, "owned": true}));
            }
            Err(libc::ENOENT) => {} // Removed between the scan and now (by its owner or an authorized ack).
            Err(_) => {
                guarded.insert(txn.clone());
                records.push(json!({"txn": txn, "state": "unknown", "owned": true}));
            }
        }
    }
    let mut entries = Vec::new();
    for name in names.iter().filter(|n| n.ends_with(".staged")) {
        // Not this caller's to take over: named, but with no bytes (#412 rounds 2 to 5).
        if txn_of(name, &key).is_some_and(|t| guarded.contains(&t)) {
            entries.push(json!({"entry": name, "owned": true}));
            continue;
        }
        let Ok(fd) = open_private(priv_fd, name) else { continue };
        if !fstat(fd.as_raw_fd()).map(|s| is_reg(&s)).unwrap_or(false) {
            continue;
        }
        let bytes = read_all(&fd)?;
        entries.push(json!({"entry": name, "hash": hex(&bytes), "data": B64.encode(&bytes)}));
    }
    Ok(json!({"ok": true, "entries": entries, "records": records}))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn die(msg: &str) -> ! {
    eprintln!("coedit-fs: {msg}");
    std::process::exit(2);
}

fn main() {
    // coedit-fs --same-account <root> <private dir>: spawned by the bridge as the account it serves (tests and dev).
    // coedit-fs --socket <private dir> [--same-account]: the service (smartyfs#32), started by systemd as its own
    //   account on a connection from the one account it serves; the root comes in the first request (hello).
    // Without --same-account it refuses to serve its own account, or to run as root: the peer on stdin (a socket, as
    // systemd's Accept=yes and Node's stdio pipes both are) must be another account. The service's unit never passes it.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let same_account = args.iter().any(|a| a == "--same-account");
    let rest: Vec<&String> = args.iter().filter(|a| *a != "--same-account").collect();
    let (socket_mode, root_arg, priv_arg) = match rest.as_slice() {
        [flag, privd] if *flag == "--socket" => (true, None, privd.as_str()),
        [root, privd] if !root.starts_with("--") => (false, Some(root.as_str()), privd.as_str()),
        _ => die("usage: coedit-fs --same-account <project root> <private dir> | coedit-fs --socket <private dir>"),
    };
    // SAFETY: geteuid cannot fail.
    let euid = unsafe { libc::geteuid() };
    let mut cred = libc::ucred { pid: 0, uid: u32::MAX, gid: u32::MAX };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: SO_PEERCRED into a ucred of the given size, on our stdin.
    let peer = (unsafe { libc::getsockopt(0, libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len) } == 0)
        .then_some(cred.uid);
    if !same_account {
        match peer {
            None => die("stdin must be a socket from the account this helper serves"),
            Some(uid) if uid == euid => die("refusing to serve its own account: the helper must run as its own account (smartyfs#32)"),
            _ if euid == 0 => die("refusing to run as root"),
            _ => {}
        }
    }
    let _ = PEER.set(peer.unwrap_or(euid));
    // A lease break is signalled with SIGIO, whose default action ends the process: the break only waits for our unlock.
    // SAFETY: ignoring a signal at startup, before any thread exists.
    unsafe { libc::signal(libc::SIGIO, libc::SIG_IGN) };
    let open_root = |root: &str| -> Result<RawFd, String> {
        let c = cstr(root)?;
        if !root.starts_with('/') {
            return Err("the root must be an absolute path".into());
        }
        // SAFETY: opens the root (the anchor of every resolution) once.
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if fd < 0 { Err(fail("open root")) } else { Ok(fd) }
    };
    let privd = CString::new(priv_arg).unwrap_or_else(|_| die("private dir"));
    // SAFETY: opens the private dir once.
    let priv_fd = unsafe { libc::open(privd.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if priv_fd < 0 {
        die(&fail("open"));
    }
    // The root: opened, admitted against the private dir and its owner, and remembered with its path (for the keys).
    let admit = |root: &str| -> Result<RawFd, String> {
        let fd = open_root(root)?;
        if let Err(e) = admit_root(fd, priv_fd) {
            // SAFETY: closing the fd we just opened.
            unsafe { libc::close(fd) };
            return Err(e);
        }
        let _ = ROOT_PATH.set(root.to_string());
        Ok(fd)
    };
    let mut root_fd: Option<RawFd> = match root_arg {
        Some(root) => Some(admit(root).unwrap_or_else(|e| die(&e))),
        None => None,
    };
    let pst = fstat(priv_fd).unwrap_or_else(|e| die(&e));
    // SAFETY: geteuid cannot fail.
    if pst.st_uid != unsafe { libc::geteuid() } || pst.st_mode & 0o077 != 0 {
        die("the private dir must be ours with mode 0700");
    }
    // A default ACL (inherited from its parent) would give our staged files named entries once fchmod sets the mask:
    // removed before anything is created (smartyfs#34 item 13). An access ACL could let others in: refused.
    let dflt = cstr(DEFAULT_ACL).unwrap_or_else(|e| die(&e));
    // SAFETY: removes an xattr of our own directory, by its fd.
    if unsafe { libc::fremovexattr(priv_fd, dflt.as_ptr()) } != 0 && ![libc::ENODATA, libc::EOPNOTSUPP].contains(&errno()) {
        die(&fail("the private dir's default ACL cannot be removed"));
    }
    if xattr(priv_fd, ACCESS_ACL).unwrap_or_else(|e| die(&e)).is_some() {
        die("the private dir must have no extended ACL");
    }
    let mut unsynced = Unsynced::new();
    let mut owned = Owned::new();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) => {
                let result = match req["op"].as_str() {
                    // The protocol version: the bridge refuses a helper that answers otherwise (smartyfs#37 item 5).
                    // In socket mode the first hello names the root (once); later requests use it.
                    Some("hello") => match (socket_mode, root_fd, req["root"].as_str()) {
                        (true, None, Some(root)) => admit(root).map(|fd| {
                            root_fd = Some(fd);
                            json!({"ok": true, "protocol": 3})
                        }),
                        (true, None, None) => Err("hello needs the root".into()),
                        (true, Some(_), Some(_)) => Err("the root is already set".into()),
                        _ => Ok(json!({"ok": true, "protocol": 3})),
                    },
                    Some("read" | "publish" | "flush" | "list" | "dispose" | "ack") if root_fd.is_none() => Err("hello with the root first".into()),
                    Some("read") => read_op(root_fd.unwrap_or(-1), &req),
                    Some("publish") => publish_op(root_fd.unwrap_or(-1), priv_fd, &req, &mut unsynced, &mut owned),
                    Some("flush") => flush_op(root_fd.unwrap_or(-1), priv_fd, &req, &mut unsynced),
                    Some("dispose") => dispose_op(priv_fd, &req, &mut owned),
                    Some("ack") => ack_op(priv_fd, &req),
                    Some("list") => list_op(priv_fd, &req, &owned),
                    // A closing bridge's proof of quiescence (#412 round 2, finding 2): operations run one at a time,
                    // so this reply means none is in flight; the helper then exits and releases what it owned.
                    Some("bye") => Ok(json!({"ok": true, "bye": true})),
                    _ => Err("unknown op".into()),
                };
                let mut v = result.unwrap_or_else(|e| json!({"ok": false, "error": e}));
                if let Some(id) = req.get("id") {
                    v["id"] = id.clone();
                }
                v
            }
            Err(_) => json!({"ok": false, "error": "invalid json"}),
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() || reply["bye"] == true {
            break;
        }
    }
}
