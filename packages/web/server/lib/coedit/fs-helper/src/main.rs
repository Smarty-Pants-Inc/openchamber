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
use serde_core::de::{Deserialize, Deserializer, Error as _, MapAccess, SeqAccess, Visitor};
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

/// Why `create_immutable` failed: before its own link (the name is NOT ours: never remove it), or after it (the name is
/// ours, and the returned fd identifies the inode we linked).
enum CreateError {
    BeforeLink(String),
    AfterLink(String, OwnedFd),
}

impl CreateError {
    fn message(&self) -> &str {
        match self {
            CreateError::BeforeLink(m) | CreateError::AfterLink(m, _) => m,
        }
    }
}

/// Creates an immutable private file atomically: an unnamed file, written, fsynced, optionally flocked, then linked
/// under `name` (EEXIST if it exists) and the private dir fsynced. Returns its fd (holding the flock if asked).
fn create_immutable(priv_fd: RawFd, name: &str, content: &[u8], lock: bool, req: &Value) -> Result<OwnedFd, CreateError> {
    let before = |m: String| CreateError::BeforeLink(m);
    if test_fault(req, "recordCreate") {
        return Err(before("the record cannot be created".into()));
    }
    let dot = CString::new(".").unwrap();
    // SAFETY: O_TMPFILE creates an unnamed file owned by the returned fd.
    let raw = unsafe { libc::openat(priv_fd, dot.as_ptr(), libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if raw < 0 {
        return Err(before(fail("O_TMPFILE")));
    }
    // SAFETY: a new owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: flock on our own fd.
    if lock && unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(before(fail("flock")));
    }
    // SAFETY: pwrite on our own fd.
    if unsafe { libc::pwrite(fd.as_raw_fd(), content.as_ptr().cast(), content.len(), 0) } != content.len() as isize || !fsync(fd.as_raw_fd()) {
        return Err(before(fail("write")));
    }
    test_pause(req, "beforeRecordLink");
    let c = cstr(name).map_err(before)?;
    let proc_path = CString::new(format!("/proc/self/fd/{}", fd.as_raw_fd())).unwrap();
    // SAFETY: links our unnamed, complete inode under a fresh private name; EEXIST if taken.
    if unsafe { libc::linkat(libc::AT_FDCWD, proc_path.as_ptr(), priv_fd, c.as_ptr(), libc::AT_SYMLINK_FOLLOW) } != 0 {
        return Err(before(fail("link")));
    }
    if test_fault(req, "recordSync") || !fsync(priv_fd) {
        return Err(CreateError::AfterLink("the private dir cannot be flushed".into(), fd));
    }
    Ok(fd)
}

/// Removes `name` only if it still holds the inode behind `fd`, the one this invocation linked (#412 round 6).
fn unlink_if_ours(priv_fd: RawFd, name: &str, fd: &OwnedFd) {
    let (Ok(st), Ok(Some(now))) = (fstat(fd.as_raw_fd()), stat_entry(priv_fd, name)) else { return };
    if same(&now, st.st_ino as u64, st.st_dev as u64) {
        if let Ok(c) = cstr(name) {
            // SAFETY: unlinks one private name that is proven to hold our own inode.
            unsafe { libc::unlinkat(priv_fd, c.as_ptr(), 0) };
        }
    }
}

/// Persisted evidence is untrusted until its entire schema has been checked. No missing field selects a mode.
#[derive(Clone, PartialEq, Eq)]
struct RecoveryDir {
    path: String,
    dev: u64,
    ino: u64,
}

#[derive(Clone, PartialEq, Eq)]
struct TxnRecord {
    ino: u64,
    ack: String,
    pid: i32,
    start: u64,
    dest: Option<RecoveryDir>,
}

/// Decode persisted JSON without collapsing duplicate decoded object keys, at any depth.
/// serde_json still owns tokenization, number handling, syntax and recursion limits; the schema checks below
/// remain authoritative. This wrapper is not used for requests or writer-generated values.
struct PersistedValue(Value);

impl<'de> Deserialize<'de> for PersistedValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PersistedVisitor;

        impl<'de> Visitor<'de> for PersistedVisitor {
            type Value = Value;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON value with unique object keys")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
                Ok(Value::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
                Ok(Value::Number(value.into()))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
                Ok(Value::Number(value.into()))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Value, E> {
                Ok(serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number))
            }

            fn visit_str<E: serde_core::de::Error>(self, value: &str) -> Result<Value, E> {
                self.visit_string(value.to_string())
            }

            fn visit_string<E>(self, value: String) -> Result<Value, E> {
                Ok(Value::String(value))
            }

            fn visit_unit<E>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<PersistedValue>()? {
                    values.push(value.0);
                }
                Ok(Value::Array(values))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = object.next_key::<String>()? {
                    if values.contains_key(&key) {
                        // Never include the untrusted key or value in diagnostics.
                        return Err(A::Error::custom("duplicate object key"));
                    }
                    values.insert(key, object.next_value::<PersistedValue>()?.0);
                }
                Ok(Value::Object(values))
            }
        }

        deserializer.deserialize_any(PersistedVisitor).map(Self)
    }
}

fn exact_fields(value: &Value, fields: &[&str]) -> bool {
    value.as_object().is_some_and(|o| o.len() == fields.len() && fields.iter().all(|f| o.contains_key(*f)))
}

fn lower_hex(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn absolute_path(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0')
        && (path == "/" || path[1..].split('/').all(|p| !p.is_empty() && p != "." && p != ".."))
}

impl TxnRecord {
    fn parse(v: &Value) -> Option<Self> {
        if !exact_fields(v, &["ino", "ack", "pid", "start", "dest"]) { return None; }
        let ino = v["ino"].as_u64().filter(|i| *i > 0)?;
        let ack = v["ack"].as_str()?;
        if !ack.is_empty() && !lower_hex(ack, 64, 64) { return None; }
        let pid = i32::try_from(v["pid"].as_u64()?).ok()?;
        let start = v["start"].as_u64()?;
        if pid == 0 && start != 0 { return None; }
        let dest = if v["dest"].is_null() {
            None
        } else {
            let d = &v["dest"];
            if !exact_fields(d, &["path", "dev", "ino"]) { return None; }
            let path = d["path"].as_str()?;
            if !absolute_path(path) { return None; }
            Some(RecoveryDir { path: path.to_string(), dev: d["dev"].as_u64()?, ino: d["ino"].as_u64().filter(|i| *i > 0)? })
        };
        Some(Self { ino, ack: ack.to_string(), pid, start, dest })
    }

    fn value(&self) -> Value {
        let dest = self.dest.as_ref().map(|d| json!({"path": d.path, "dev": d.dev, "ino": d.ino}));
        json!({"ino": self.ino, "ack": self.ack, "pid": self.pid, "start": self.start, "dest": dest})
    }
}

/// Diagnostics name evidence, never its contents, token hash, or untrusted path.
fn metadata_error(name: &str, reason: &str) -> String {
    format!("invalid metadata {name}: {reason}")
}

fn check_metadata(fd: RawFd, name: &str) -> Result<(), String> {
    let st = fstat(fd).map_err(|_| metadata_error(name, "cannot inspect"))?;
    // SAFETY: geteuid cannot fail.
    if !is_reg(&st) || st.st_uid != unsafe { libc::geteuid() } || st.st_mode & 0o7077 != 0
        || xattr(fd, ACCESS_ACL).map_err(|_| metadata_error(name, "cannot inspect ACL"))?.is_some() {
        return Err(metadata_error(name, "must be a regular helper-owned private file"));
    }
    Ok(())
}

/// A metadata file's bytes: None only on ENOENT; never follows a link or reads a special/foreign file.
fn read_private(priv_fd: RawFd, name: &str) -> Result<Option<(OwnedFd, Vec<u8>)>, String> {
    let fd = match open_private(priv_fd, name) {
        Ok(fd) => fd,
        Err(libc::ENOENT) => return Ok(None),
        Err(_) => return Err(metadata_error(name, "cannot open without following links")),
    };
    check_metadata(fd.as_raw_fd(), name)?;
    let bytes = read_all(&fd).map_err(|_| metadata_error(name, "cannot read"))?;
    Ok(Some((fd, bytes)))
}

/// An exact, trusted transaction snapshot. Missing and invalid records are different from explicit tokenless mode.
fn record_info(priv_fd: RawFd, key: &str, txn: &str) -> Result<Option<TxnRecord>, String> {
    let name = format!("{key}.{txn}.txn");
    if !lower_hex(key, 16, 16) || !lower_hex(txn, 1, 32) { return Err(metadata_error(&name, "invalid filename")); }
    let Some((fd, bytes)) = read_private(priv_fd, &name)? else { return Ok(None) };
    let value = serde_json::from_slice::<PersistedValue>(&bytes).map_err(|_| metadata_error(&name, "invalid JSON"))?.0;
    let record = TxnRecord::parse(&value).ok_or_else(|| metadata_error(&name, "invalid transaction schema"))?;
    if !fsync(fd.as_raw_fd()) || !fsync(priv_fd) { return Err(metadata_error(&name, "cannot confirm durability")); }
    Ok(Some(record))
}

fn required_record(priv_fd: RawFd, key: &str, txn: &str) -> Result<TxnRecord, String> {
    record_info(priv_fd, key, txn)?.ok_or_else(|| metadata_error(&format!("{key}.{txn}.txn"), "missing transaction record"))
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
    let record = required_record(priv_fd, key, txn)?;
    if let Some(state) = outcome(priv_fd, key, txn, req)? {
        return Ok(state);
    }
    let state = match staged_name(priv_fd, key, txn, req)? {
        None => "aborted",
        Some(name) => match stat_entry(priv_fd, &name)? {
            Some(st) if st.st_ino as u64 != record.ino => "published",
            Some(_) => "aborted",
            None => return Err("the staged entry changed during recovery".into()),
        },
    };
    if test_fault(req, "recordWrite") {
        return Err("the transaction's outcome cannot be recorded".into());
    }
    match create_immutable(priv_fd, &format!("{key}.{txn}.out"), state.as_bytes(), false, req) {
        Ok(_) => Ok(state.to_string()),
        // Another recovery linked it first, or ours is not yet flushed: trust it only once it is confirmed durable.
        Err(_) => outcome(priv_fd, key, txn, req)?.ok_or_else(|| "the transaction's outcome cannot be recorded".to_string()),
    }
}

/// Removes a transaction's record and outcome (its data entry is gone and its bridge has settled or heard it).
fn retire(priv_fd: RawFd, key: &str, txn: &str, req: &Value) -> Result<(), String> {
    required_record(priv_fd, key, txn)?;
    if staged_name(priv_fd, key, txn, req)?.is_some() { return Err("the transaction still has retained data".into()); }
    validate_evidence(priv_fd, key, req)?;
    for suffix in ["out", "txn"] {
        let name = format!("{key}.{txn}.{suffix}");
        let c = cstr(&name)?;
        // SAFETY: unlinks validated evidence only after the transaction has no retained data.
        if unsafe { libc::unlinkat(priv_fd, c.as_ptr(), 0) } != 0 && errno() != libc::ENOENT {
            return Err(metadata_error(&name, "cannot retire"));
        }
    }
    if !fsync(priv_fd) { return Err("the retired transaction cannot be confirmed durable".into()); }
    Ok(())
}

/// The staged entry of a transaction, `<key>.<txn>-<unique>.staged`: None only when a complete scan finds none.
fn staged_name(priv_fd: RawFd, key: &str, txn: &str, req: &Value) -> Result<Option<String>, String> {
    if test_fault(req, "stagedScan") {
        return Err("the private dir cannot be scanned".into());
    }
    let prefix = format!("{key}.{txn}-");
    for n in key_names(priv_fd, key)? {
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
    // A hyphenated staged identity is transaction-bearing even when its txn is malformed. Never reclassify it
    // as a legacy unowned entry; required_record will reject its filename or missing evidence.
    Some(txn.to_string())
}

/// Takes a transaction's record lock: Some(fd), None while another live connection owns it, or Err (no record: ENOENT).
fn lock_record(priv_fd: RawFd, key: &str, txn: &str) -> Result<Option<OwnedFd>, i32> {
    let name = format!("{key}.{txn}.txn");
    let fd = open_private(priv_fd, &name)?;
    check_metadata(fd.as_raw_fd(), &name).map_err(|_| libc::EINVAL)?;
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
fn may_recover(priv_fd: RawFd, key: &str, txn: &str, token: Option<&str>, _req: &Value) -> Result<bool, String> {
    let record = required_record(priv_fd, key, txn)?;
    let want = &record.ack;
    if want.is_empty() || token.is_some_and(|t| !t.is_empty() && hex(t.as_bytes()) == *want) {
        return Ok(true);
    }
    // A caller never gains authority from its origin's exit (#428 round 1): that only lets the HELPER recover the
    // bytes itself (recover_orphan). Without the token, a caller may act only on an old orphan (7 days).
    let name = format!("{key}.{txn}.txn");
    let (fd, _) = read_private(priv_fd, &name)?.ok_or_else(|| metadata_error(&name, "missing transaction record"))?;
    let st = fstat(fd.as_raw_fd()).map_err(|_| metadata_error(&name, "cannot inspect retention age"))?;
    Ok(now_secs() - st.st_ctime as i64 > ORPHAN_SECS)
}

/// Whether a transaction's originating process is PROVEN gone (#428 round 1, finding 2): `kill(pid, 0)` says ESRCH (in
/// this helper's PID namespace), or a known nonzero recorded start differs from a readable start (reused). An unknown
/// recorded start (0), hidden or unreadable /proc (hidepid returns ENOENT for a live process), and EPERM without
/// readable reuse proof count as alive.
fn origin_gone(record: &TxnRecord, req: &Value) -> bool {
    let (pid, start) = (record.pid, record.start);
    if pid == 0 {
        return false;
    }
    // SAFETY: signal 0 only checks existence and permission; no signal is sent.
    let exists = unsafe { libc::kill(pid as i32, 0) } == 0 || errno() != libc::ESRCH;
    if !exists {
        return true;
    }
    // Tests only: procfs hides the process (as hidepid does): ENOENT at the read, for a live process.
    let looked = if test_fault(req, "procHidden") { Ok(None) } else { process_start(pid as i32) };
    matches!(looked, Ok(Some(now)) if start != 0 && now != start)
}

/// Version 1 receipts are self-contained after txn retirement. Old path/hash-only receipts are unverified and
/// retained as errors, never migrated or used for cleanup.
struct DoneRecord {
    key: String,
    txn: String,
    record: TxnRecord,
    path: String,
    hash: String,
    dev: u64,
    ino: u64,
}

impl DoneRecord {
    fn parse(v: &Value, name: &str, key: &str) -> Option<Self> {
        if !exact_fields(v, &["version", "key", "txn", "record", "path", "hash", "copy"]) || v["version"].as_u64()? != 1 { return None; }
        let k = v["key"].as_str()?;
        let txn = v["txn"].as_str()?;
        let hash = v["hash"].as_str()?;
        if k != key || !lower_hex(k, 16, 16) || !lower_hex(txn, 1, 32) || !lower_hex(hash, 64, 64)
            || name != format!("{k}.{txn}.{}.done", &hash[..16]) { return None; }
        let record = TxnRecord::parse(&v["record"])?;
        let dest = record.dest.as_ref()?;
        let path = v["path"].as_str()?;
        let prefix = format!("{}/", dest.path.trim_end_matches('/'));
        let base = path.strip_prefix(&prefix)?;
        // The writer's one recovery-format basename, with no second component or alternate transaction.
        let stamp = base.get(..24)?;
        if !stamp.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 | 13 | 16 | 19 => b == b'-', 10 => b == b'T', 23 => b == b'Z', _ => b.is_ascii_digit(),
        }) { return None; }
        let rest = base.get(24..)?.strip_prefix('-')?;
        let random = rest.get(..8)?;
        if !lower_hex(random, 8, 8) { return None; }
        let binding = format!("-{k}-rec{txn}{}-", &hash[..16]);
        let tail = rest.get(8..)?.strip_prefix(&binding)?;
        if tail.is_empty() || base.len() > 255 || base.contains('/') || base.contains('\0') { return None; }
        let copy = &v["copy"];
        if !exact_fields(copy, &["dev", "ino"]) { return None; }
        Some(Self { key: k.to_string(), txn: txn.to_string(), record, path: path.to_string(), hash: hash.to_string(),
            dev: copy["dev"].as_u64()?, ino: copy["ino"].as_u64().filter(|i| *i > 0)? })
    }

    fn value(&self) -> Value {
        json!({"version": 1, "key": self.key, "txn": self.txn, "record": self.record.value(), "path": self.path,
            "hash": self.hash, "copy": {"dev": self.dev, "ino": self.ino}})
    }
}

fn done_info(priv_fd: RawFd, name: &str, key: &str) -> Result<(OwnedFd, DoneRecord), String> {
    let (fd, bytes) = read_private(priv_fd, name)?.ok_or_else(|| metadata_error(name, "missing delivery receipt"))?;
    let value = serde_json::from_slice::<PersistedValue>(&bytes).map_err(|_| metadata_error(name, "invalid JSON"))?.0;
    let done = DoneRecord::parse(&value, name, key).ok_or_else(|| metadata_error(name, "unverified delivery schema or binding"))?;
    if record_info(priv_fd, key, &done.txn)?.is_some_and(|r| r != done.record) {
        return Err(metadata_error(name, "transaction snapshot differs"));
    }
    Ok((fd, done))
}

/// Holds a read lease on stable bytes. This protects the opened inode, not its directory names.
/// A delivered inode alone is never durable protection for retained-byte removal.
struct ReadLease(OwnedFd);

impl Drop for ReadLease {
    fn drop(&mut self) {
        // SAFETY: releases the lease on the descriptor this object owns, before its close.
        unsafe { libc::fcntl(self.0.as_raw_fd(), libc::F_SETLEASE, libc::F_UNLCK) };
    }
}

struct VerifiedDelivery {
    _dest: OwnedFd,
    _copy: ReadLease,
}

fn copy_private(fd: RawFd, st: &libc::stat) -> Result<bool, String> {
    // SAFETY: geteuid cannot fail. The ACL mask may make the mode 0660 for a 0600 + peer-ACL delivery.
    if !is_reg(st) || st.st_uid != unsafe { libc::geteuid() } || st.st_mode & 0o7007 != 0 { return Ok(false); }
    match xattr(fd, ACCESS_ACL)? {
        None => Ok(st.st_mode & 0o070 == 0),
        Some(acl) => Ok(acl_entries(&acl).is_some_and(|entries| entries.iter().all(|&(tag, perm, id)| match tag {
            ACL_USER => perm == 0 || trusted(id),
            ACL_GROUP_OBJ | ACL_GROUP | ACL_OTHER => perm == 0,
            ACL_USER_OBJ | ACL_MASK => true,
            _ => false,
        }))),
    }
}

/// Reopen the original bound directory and verify the actual delivered inode/bytes, including on every retry.
/// A missing copy is historical only after txn retirement or the 7-day receipt period AND with no retained data.
/// Historical receipts are omitted from fresh deliveries and may age out. A recent unresolved missing copy fails.
fn verify_delivery(priv_fd: RawFd, name: &str, marker: &OwnedFd, done: &DoneRecord, retained: bool,
    bytes: Option<&[u8]>, req: &Value) -> Result<Option<VerifiedDelivery>, String> {
    let err = |reason| metadata_error(name, reason);
    let bound = done.record.dest.as_ref().ok_or_else(|| err("missing destination snapshot"))?;
    let dest = open_recovery(&bound.path, priv_fd, None).map_err(|_| err("bound recovery directory cannot be reopened privately"))?;
    if !same(&fstat(dest.as_raw_fd()).map_err(|_| err("cannot inspect destination"))?, bound.ino, bound.dev) {
        return Err(err("bound recovery directory changed"));
    }
    let base = done.path.rsplit('/').next().ok_or_else(|| err("invalid recovery basename"))?;
    let copy = match open_beneath(dest.as_raw_fd(), base, RDONLY) {
        Ok(fd) => fd,
        Err(libc::ENOENT) if !retained && (now_secs() - fstat(marker.as_raw_fd())?.st_ctime as i64 > ORPHAN_SECS
            || record_info(priv_fd, &done.key, &done.txn)?.is_none()) => {
            if test_fault(req, "recordSync") || !fsync(marker.as_raw_fd()) || !fsync(dest.as_raw_fd()) || !fsync(priv_fd) {
                return Err(err("historical receipt cannot be confirmed durable"));
            }
            return Ok(None);
        }
        Err(_) => return Err(err("delivered copy is missing or cannot be opened safely")),
    };
    test_gate(req, "deliveryOpened", &done.path)?; // After open, before the first delivered-inode observation.
    let before = fstat(copy.as_raw_fd()).map_err(|_| err("cannot inspect delivered copy"))?;
    if !same(&before, done.ino, done.dev) || !copy_private(copy.as_raw_fd(), &before).map_err(|_| err("cannot inspect copy privacy"))? {
        return Err(err("delivered copy identity or privacy differs"));
    }
    // SAFETY: lease on our opened copy. A writer-held copy is not proof of stable delivered bytes, not success/busy.
    if unsafe { libc::fcntl(copy.as_raw_fd(), libc::F_SETLEASE, libc::F_RDLCK) } != 0 {
        return Err(err("delivered copy cannot be leased for verification"));
    }
    let copy = ReadLease(copy);
    let actual = read_all(&copy.0).map_err(|_| err("cannot read delivered copy"))?;
    let after = fstat(copy.0.as_raw_fd()).map_err(|_| err("cannot reinspect delivered copy"))?;
    if hex(&actual) != done.hash || bytes.is_some_and(|b| b != actual)
        || before.st_size != after.st_size || before.st_mtime != after.st_mtime || before.st_mtime_nsec != after.st_mtime_nsec
        || before.st_ctime != after.st_ctime || before.st_ctime_nsec != after.st_ctime_nsec {
        return Err(err("delivered bytes differ or changed during verification"));
    }
    if test_fault(req, "recordSync") || test_fault(req, "deliverSync") || !fsync(copy.0.as_raw_fd()) || !fsync(marker.as_raw_fd())
        || test_fault(req, "dirSync") || !fsync(dest.as_raw_fd()) || test_fault(req, "privSync") || !fsync(priv_fd) {
        return Err(err("delivery cannot be confirmed durable"));
    }
    Ok(Some(VerifiedDelivery { _dest: dest, _copy: copy }))
}

fn key_names(priv_fd: RawFd, key: &str) -> Result<Vec<String>, String> {
    let prefix = format!("{key}.");
    let mut names = Vec::new();
    for e in std::fs::read_dir(format!("/proc/self/fd/{priv_fd}")).map_err(|_| "the private dir cannot be scanned")? {
        let n = e.map_err(|_| "the private dir cannot be scanned")?.file_name();
        if n.as_encoded_bytes().starts_with(prefix.as_bytes()) {
            let text = n.to_str().ok_or_else(|| metadata_error(&n.to_string_lossy(), "invalid filename encoding"))?;
            names.push(text.to_string());
        }
    }
    names.sort();
    Ok(names)
}

/// Preflight the entire file key before outcomes, authority, cleanup or list mutations. Invalid evidence cannot
/// produce successful partial absence; another key is independent. Transaction-bearing entries require records.
fn validate_evidence(priv_fd: RawFd, key: &str, req: &Value) -> Result<Vec<String>, String> {
    let names = key_names(priv_fd, key)?;
    for name in &names {
        if let Some(txn) = name.strip_suffix(".txn").and_then(|n| n.strip_prefix(&format!("{key}."))) {
            required_record(priv_fd, key, txn)?;
        }
    }
    for name in &names {
        if name.ends_with(".staged") {
            if let Some(txn) = txn_of(name, key) { required_record(priv_fd, key, &txn)?; }
        } else if let Some(txn) = name.strip_suffix(".out").and_then(|n| n.strip_prefix(&format!("{key}."))) {
            required_record(priv_fd, key, txn)?;
            let (_, bytes) = read_private(priv_fd, name)?.ok_or_else(|| metadata_error(name, "missing outcome"))?;
            if bytes != b"published" && bytes != b"aborted" { return Err(metadata_error(name, "invalid outcome")); }
        } else if name.ends_with(".done") {
            let (fd, done) = done_info(priv_fd, name, key)?;
            let prefix = format!("{key}.{}-", done.txn);
            let retained = names.iter().any(|n| n.starts_with(&prefix) && n.ends_with(".staged"));
            verify_delivery(priv_fd, name, &fd, &done, retained, None, req)?;
        }
    }
    Ok(names)
}

/// An independent copy of the retained bytes, never a hard link to the peer-writable delivery or displaced inode.
/// The served account cannot reach this 0600 file in the helper's 0700 directory. Existing anchors must match
/// exactly and are fsynced again on retry. They are not staged entries, cannot be named by dispose, and are never
/// removed by receipt/transaction retirement. Releasing them needs a separate authorized retention decision.
fn protect_delivery(priv_fd: RawFd, marker: &str, bytes: &[u8], req: &Value) -> Result<(), String> {
    let name = format!("{marker}.anchor");
    let fd = match read_private(priv_fd, &name)? {
        Some((fd, actual)) => {
            if actual != bytes { return Err(metadata_error(&name, "protected bytes differ")); }
            fd
        }
        None => {
            if test_fault(req, "anchorCreate") { return Err(metadata_error(&name, "cannot create protected copy")); }
            create_immutable(priv_fd, &name, bytes, false, req).map_err(|e| metadata_error(&name, e.message()))?
        }
    };
    if test_fault(req, "anchorSync") || !fsync(fd.as_raw_fd()) || !fsync(priv_fd) {
        return Err(metadata_error(&name, "protected copy cannot be confirmed durable"));
    }
    Ok(())
}

/// Verify any prior delivery and protect these leased retained bytes before any path can unlink them.
fn verify_txn_deliveries(priv_fd: RawFd, key: &str, txn: &str, bytes: &[u8], req: &Value) -> Result<Vec<VerifiedDelivery>, String> {
    let prefix = format!("{key}.{txn}.");
    let mut verified = Vec::new();
    for name in key_names(priv_fd, key)?.iter().filter(|n| n.starts_with(&prefix) && n.ends_with(".done")) {
        let (fd, done) = done_info(priv_fd, name, key)?;
        let delivery = verify_delivery(priv_fd, name, &fd, &done, true, Some(bytes), req)?
            .ok_or_else(|| metadata_error(name, "missing retained-byte delivery"))?;
        protect_delivery(priv_fd, name, bytes, req)?;
        verified.push(delivery);
    }
    Ok(verified)
}

/// Under the record lock and a retained-inode read lease, deliver into the origin's bound directory, never the
/// requesting connection's. The copy is helper-owned, 0600 plus peer read/write ACL. A version-1 receipt binds the
/// transaction snapshot and actual delivered inode/hash. Verify and fsync all evidence on EVERY retry before
/// unlink, with an independent durable private anchor before retained removal. A lease alone cannot protect names.
fn recover_orphan(priv_fd: RawFd, key: &str, txn: &str, name: &str, req: &Value) -> Result<bool, String> {
    let record = required_record(priv_fd, key, txn)?;
    let Some(bound) = &record.dest else { return Ok(false) };
    let record_name = format!("{key}.{txn}.txn");
    let dest = open_recovery(&bound.path, priv_fd, None).map_err(|_| metadata_error(&record_name, "bound recovery directory cannot be reopened privately"))?;
    if !same(&fstat(dest.as_raw_fd())?, bound.ino, bound.dev) {
        return Err(metadata_error(&record_name, "bound recovery directory changed"));
    }
    let Some(staged) = staged_name(priv_fd, key, txn, req)? else { return Ok(false) };
    let fd = open_private(priv_fd, &staged).map_err(|e| os_err("open retained data", e))?;
    if !is_reg(&fstat(fd.as_raw_fd())?) { return Err("not a regular file".into()); }
    // SAFETY: a lease on our retained descriptor; EAGAIN alone means a writer is still open.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETLEASE, libc::F_RDLCK) } != 0 {
        return if errno() == libc::EAGAIN { Ok(false) } else { Err(fail("lease")) };
    }
    let fd = ReadLease(fd);
    let bytes = read_all(&fd.0)?;
    let hash = hex(&bytes);
    let h16 = &hash[..16];
    let marker = format!("{key}.{txn}.{h16}.done");
    let prior = verify_txn_deliveries(priv_fd, key, txn, &bytes, req)?;
    let _verified = if prior.is_empty() {
        let delivered = deliver(dest.as_raw_fd(), key, &format!("rec{txn}{h16}"), name, &bytes, req)?;
        let copy = open_beneath(dest.as_raw_fd(), &delivered, RDONLY).map_err(|_| metadata_error(&marker, "cannot inspect new delivery"))?;
        let st = fstat(copy.as_raw_fd())?;
        let path = format!("{}/{delivered}", bound.path.trim_end_matches('/'));
        let done = DoneRecord { key: key.to_string(), txn: txn.to_string(), record,
            path, hash, dev: st.st_dev as u64, ino: st.st_ino as u64 };
        // Validate our own writer before publishing even a receipt.
        let value = done.value();
        if DoneRecord::parse(&value, &marker, key).is_none() { return Err(metadata_error(&marker, "writer produced an invalid receipt")); }
        create_immutable(priv_fd, &marker, value.to_string().as_bytes(), false, req).map_err(|e| metadata_error(&marker, e.message()))?;
        verify_txn_deliveries(priv_fd, key, txn, &bytes, req)?
    } else { prior };
    if _verified.is_empty() { return Err(metadata_error(&marker, "missing delivery receipt before unlink")); }
    // Tests only: signal this helper after a nonempty, genuinely verified delivery, before retained unlink.
    if test_fault(req, "sigioAfterDelivery") {
        // SAFETY: raise targets only this process; no external PID or kernel lease manipulation.
        if unsafe { libc::raise(libc::SIGIO) } != 0 { return Err("test SIGIO raise failed".into()); }
    }
    required_record(priv_fd, key, txn)?; // Retry durability includes the immutable transaction snapshot.
    let c = cstr(&staged)?;
    // SAFETY: independently copied bytes are durably named in the helper-private directory before this unlink.
    if unsafe { libc::unlinkat(priv_fd, c.as_ptr(), 0) } != 0 { return Err(fail("unlinkat")); }
    if !fsync(priv_fd) { return Err("the recovered entry unlink cannot be confirmed durable".into()); }
    Ok(true)
}

/// Writes `bytes` as a new file in the recovery directory, named as the bridge names its copies
/// (`<time>-<random>-<key>-<kind>-<name>`, within NAME_MAX), durable before it returns its name.
fn deliver(recovery: RawFd, key: &str, kind: &str, name: &str, bytes: &[u8], req: &Value) -> Result<String, String> {
    if test_fault(req, "deliver") {
        return Err("the recovery directory cannot be written".into());
    }
    let dot = CString::new(".").unwrap();
    // SAFETY: O_TMPFILE in the admitted recovery directory, owned by the returned fd.
    let raw = unsafe { libc::openat(recovery, dot.as_ptr(), libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if raw < 0 {
        return Err(fail("the recovery directory cannot be written (grant the helper's account rwx on it)"));
    }
    // SAFETY: a new owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // Private (#428 round 2): 0600 for the helper, plus exactly one named entry letting the account served read and
    // write it (it is that account's recovery copy). No inherited or other entries: no one else can read it.
    let peer = *PEER.get().ok_or("no peer")?;
    let acl = acl_bytes(&[(ACL_USER_OBJ, 6, u32::MAX), (ACL_USER, 6, peer), (ACL_GROUP_OBJ, 0, u32::MAX), (ACL_MASK, 6, u32::MAX), (ACL_OTHER, 0, u32::MAX)]);
    let acl_name = cstr(ACCESS_ACL)?;
    // SAFETY: fsetxattr/pwrite on our own fd.
    let ok = unsafe {
        libc::fsetxattr(fd.as_raw_fd(), acl_name.as_ptr(), acl.as_ptr().cast(), acl.len(), 0) == 0
            && libc::pwrite(fd.as_raw_fd(), bytes.as_ptr().cast(), bytes.len(), 0) == bytes.len() as isize
    };
    if !ok || !fsync(fd.as_raw_fd()) {
        return Err(fail("write recovery"));
    }
    let prefix = format!("{}-{}-{key}-{kind}-", iso_now(), &hex(unique().as_bytes())[..8]);
    let mut tail = name.to_string();
    while prefix.len() + tail.len() > 255 {
        tail.remove(0);
    }
    let full = format!("{prefix}{tail}");
    let c = cstr(&full)?;
    let proc_path = CString::new(format!("/proc/self/fd/{}", fd.as_raw_fd())).unwrap();
    // SAFETY: links our complete inode under a fresh name in the recovery directory.
    if unsafe { libc::linkat(libc::AT_FDCWD, proc_path.as_ptr(), recovery, c.as_ptr(), libc::AT_SYMLINK_FOLLOW) } != 0 || !fsync(recovery) {
        return Err(fail("link recovery"));
    }
    Ok(full)
}

/// UTC now as the bridge's recovery names write it: `YYYY-MM-DDTHH-MM-SS-mmmZ`.
fn iso_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// The process that connected to this helper (the bridge's server), as its pid and start time: a pair the kernel never
/// reuses, unlike a pid alone.
static ORIGIN: std::sync::OnceLock<(i32, u64)> = std::sync::OnceLock::new();

/// A process's start time (clock ticks since boot, /proc/<pid>/stat field 22): None only when it does not exist.
fn process_start(pid: i32) -> Result<Option<u64>, String> {
    let text = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    // The command name is in parentheses and may contain spaces: fields are counted after its closing parenthesis.
    let rest = text.rsplit_once(')').map(|(_, r)| r).ok_or("unreadable stat")?;
    rest.split_whitespace().nth(19).and_then(|f| f.parse().ok()).map(Some).ok_or_else(|| "unreadable stat".into())
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
/// Whether `target` is the directory `from` or one of its ancestors (walking `..`, by device and inode).
fn reaches(from: RawFd, target: &libc::stat) -> Result<bool, String> {
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
}

/// The bridge's recovery directory, where the helper itself delivers what it recovers from orphans (#428 round 1):
/// named in hello, opened once without following a link and held by fd. It must belong to the account served, let no
/// group or other write, and be neither inside the private dir nor inside the project root.
static RECOVERY: std::sync::OnceLock<(RawFd, String)> = std::sync::OnceLock::new();

fn admit_recovery(path: &str, priv_fd: RawFd, root_fd: Option<RawFd>) -> Result<RawFd, String> {
    open_recovery(path, priv_fd, root_fd).map(|fd| std::os::fd::IntoRawFd::into_raw_fd(fd))
}

/// Opens and checks a recovery directory (#428 rounds 1 and 2): the account served owns it; no one else has any
/// access to it (no other bits, and every ACL entry beyond the owner's names a trusted account); it is outside the
/// private directory and the project.
fn open_recovery(path: &str, priv_fd: RawFd, root_fd: Option<RawFd>) -> Result<OwnedFd, String> {
    if !path.starts_with('/') {
        return Err("the recovery directory must be an absolute path".into());
    }
    let c = cstr(path)?;
    // SAFETY: opens the recovery directory once, never following a link at its last component.
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(fail("open recovery"));
    }
    // SAFETY: a new owned descriptor (kept for the helper's lifetime once admitted).
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let st = fstat(fd)?;
    // Private to the served account and the helper (#428 round 2): no other bits at all; group bits only as the mask
    // of an ACL whose every entry beyond the owner's names a trusted account (the helper's grant), with the owning
    // group given nothing. Delivered copies are private too (deliver), so no one else can read them.
    let acl_ok = || -> Result<bool, String> {
        let Some(acl) = xattr(fd, ACCESS_ACL)? else { return Ok(false) };
        Ok(acl_entries(&acl).is_some_and(|entries| {
            entries.iter().all(|&(tag, perm, id)| match tag {
                ACL_USER => trusted(id),
                ACL_GROUP_OBJ | ACL_GROUP | ACL_OTHER => perm == 0,
                _ => true,
            })
        }))
    };
    if PEER.get() != Some(&st.st_uid) || st.st_mode & 0o007 != 0 || (st.st_mode & 0o070 != 0 && !acl_ok()?) {
        return Err("the recovery directory must belong to the account served, private to it and this helper".into());
    }
    if reaches(fd, &fstat(priv_fd)?)? {
        return Err("the recovery directory is inside the helper's private directory".into());
    }
    if let Some(root) = root_fd {
        if reaches(fd, &fstat(root)?)? {
            return Err("the recovery directory is inside the project".into());
        }
    }
    Ok(owned)
}

fn admit_root(root_fd: RawFd, priv_fd: RawFd) -> Result<(), String> {
    let rst = fstat(root_fd)?;
    if PEER.get() != Some(&rst.st_uid) {
        return Err("the project root must belong to the account this helper serves".into());
    }
    let pst = fstat(priv_fd)?;
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

/// Tests only: a socket handshake, with no sleeps or timing window. The test resumes this exact point.
fn test_gate(req: &Value, point: &str, path: &str) -> Result<(), String> {
    if !testing() || req["gate"].as_str() != Some(point) { return Ok(()); }
    let socket = req["gateSocket"].as_str().ok_or("missing test gate socket")?;
    let mut stream = std::os::unix::net::UnixStream::connect(socket).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).map_err(|e| e.to_string())?;
    writeln!(stream, "{}", json!({"path": path})).map_err(|e| e.to_string())?;
    let mut resume = [0];
    stream.read_exact(&mut resume).map_err(|e| e.to_string())
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
    test_pause(req, "beforeLock");
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
    // Surviving delivery receipts also reserve this full identity after transaction retirement.
    let prefix = format!("{key}.{txn}.");
    if key_names(priv_fd, &key)?.iter().any(|n| n.starts_with(&prefix) && (n.ends_with(".txn") || n.ends_with(".out") || n.ends_with(".done"))) {
        return Err("this transaction id is already in use: nothing published".into());
    }
    // Plain helper callers may intentionally omit ack. The persisted writer always emits an explicit valid field.
    let ack_hash = match req.get("ack") {
        None => String::new(),
        Some(Value::String(s)) if s.is_empty() || lower_hex(s, 64, 64) => s.clone(),
        _ => return Err("invalid ack".into()),
    };
    // The transaction record, before any change (#412 round 3): created exclusively, locked by this connection, and
    // durable with our staged inode, so the outcome can always be decided from it. Without it, nothing is published.
    let record_name = format!("{key}.{txn}.txn");
    let (origin_pid, origin_start) = match (testing(), req["testOrigin"].as_array()) {
        // Tests only: a chosen origin (a pid reused by another process, or one that cannot be looked up).
        (true, Some(o)) if o.len() == 2 => (
            i32::try_from(o[0].as_u64().ok_or("invalid test origin pid")?).map_err(|_| "invalid test origin pid")?,
            o[1].as_u64().ok_or("invalid test origin start")?,
        ),
        (true, Some(_)) => return Err("invalid test origin".into()),
        _ => ORIGIN.get().copied().unwrap_or((0, 0)),
    };
    // The recovery destination is bound to this transaction here, as its origin admitted it (#428 round 2): a later
    // connection's hello never retargets it.
    let dest = match RECOVERY.get() {
        Some((fd, path)) => {
            let st = fstat(*fd)?;
            Some(json!({"path": path, "dev": st.st_dev as u64, "ino": st.st_ino as u64}))
        }
        None => None, // Intentionally unbound, never a failed destination observation.
    };
    let value = json!({"ino": ours.st_ino as u64, "ack": ack_hash, "pid": origin_pid, "start": origin_start, "dest": dest});
    let trusted = TxnRecord::parse(&value).ok_or("the writer cannot establish a valid transaction record: nothing published")?;
    let record_bytes = trusted.value().to_string();
    let record = match create_immutable(priv_fd, &record_name, record_bytes.as_bytes(), true, req) {
        Ok(fd) => fd,
        // Linked by us but not flushed: ours, proven by its inode, so it goes. Before our link: never ours to touch.
        Err(CreateError::AfterLink(m, fd)) => {
            unlink_if_ours(priv_fd, &record_name, &fd);
            return Err(format!("the transaction record cannot be established ({m}): nothing published"));
        }
        Err(e) => return Err(format!("the transaction record cannot be established ({}): nothing published", e.message())),
    };
    // Every later pre-exchange cleanup removes only the inode we linked.
    let drop_record = || unlink_if_ours(priv_fd, &record_name, &record);
    let staged = format!("{key}.{txn}-{}.staged", unique());
    let staged_c = cstr(&staged)?;
    let proc_path = CString::new(format!("/proc/self/fd/{}", tmp.as_raw_fd())).unwrap();
    // SAFETY: links our unnamed inode (through its fd) under a fresh private name; EEXIST if taken.
    if unsafe { libc::linkat(libc::AT_FDCWD, proc_path.as_ptr(), priv_fd, staged_c.as_ptr(), libc::AT_SYMLINK_FOLLOW) } != 0 {
        drop_record();
        return Err(fail("linkat"));
    }
    // Our own staged entry (a fresh unique name) and our own record (by its inode): nothing was published.
    let unlink_staged = || {
        // SAFETY: unlinks our own fresh private entry.
        unsafe { libc::unlinkat(priv_fd, staged_c.as_ptr(), 0) };
        drop_record();
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
    validate_evidence(priv_fd, &key, req)?;
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
            Err(libc::ENOENT) if stat_entry(priv_fd, &entry)?.is_none() => None, // Idempotent disposal of absent data only.
            Err(libc::ENOENT) => return Err(metadata_error(&format!("{key}.{txn}.txn"), "missing transaction record")),
            Err(_) => return Err(metadata_error(&format!("{key}.{txn}.txn"), "transaction record cannot be locked")),
        };
        if let Some(fd) = lock {
            if !may_recover(priv_fd, &key, &txn, token, req)? {
                // Never this caller's; if its origin is proven gone, the helper recovers the bytes itself.
                if origin_gone(&required_record(priv_fd, &key, &txn)?, req) {
                    resolve(priv_fd, &key, &txn, req)?;
                    let (_, file_name) = split(req["path"].as_str().ok_or("path")?)?;
                    let recovered = recover_orphan(priv_fd, &key, &txn, &file_name, req)?;
                    return Ok(json!({"ok": false, "owned": true, "recovered": recovered}));
                }
                return Ok(json!({"ok": false, "owned": true}));
            }
            // The outcome is durable before the evidence it was derived from may go; otherwise nothing is removed.
            resolve(priv_fd, &key, &txn, req)?;
            let Some(st) = stat_entry(priv_fd, &entry)? else {
                // Already disposed: release this temporary claim, keeping the receipt available for ack.
                return Ok(json!({"ok": true}));
            };
            let ino = st.st_ino as u64;
            owned.insert(id.clone(), OwnedTxn { _record: fd, entry: entry.clone(), ino, heard: false });
        } else {
            return dispose_named(priv_fd, req, &entry, hash);
        }
    }
    resolve(priv_fd, &key, &txn, req)?; // Own-connection authority also requires valid durable evidence.
    let mine = owned.remove(&id).ok_or("lost ownership")?;
    // The owner acts only on exactly the entry its transaction produced, still holding that displaced inode.
    let genuine = entry == mine.entry && match stat_entry(priv_fd, &entry) {
        Ok(Some(st)) => st.st_ino as u64 == mine.ino,
        Ok(None) => true, // Only the exact owned entry may complete after its data is already gone.
        Err(_) => false,
    };
    if !genuine {
        owned.insert(id, mine);
        return Ok(json!({"ok": false, "error": "not this transaction's entry"}));
    }
    let done = dispose_named(priv_fd, req, &entry, hash);
    if matches!(&done, Ok(v) if v["ok"] == true) {
        // Its data is gone. Retired only by the connection that published it (its bridge heard the reply); after a
        // claim, the outcome stays for the originating bridge until it acks (#412 round 5).
        if mine.heard {
            retire(priv_fd, &key, &txn, req)?;
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
    validate_evidence(priv_fd, &key, req)?;
    let done = match lock_record(priv_fd, &key, txn) {
        Ok(Some(_fd)) => {
            // Only the originating bridge's secret token may remove the receipt; the txn in `list` grants nothing.
            let record = required_record(priv_fd, &key, txn)?;
            let want = &record.ack;
            if token.is_empty() || want.is_empty() || hex(token.as_bytes()) != *want {
                return Ok(json!({"ok": false, "error": "not this transaction's owner"}));
            }
            // Its retained data is still there: the record keeps guarding it until that data is disposed (#412 r5).
            if staged_name(priv_fd, &key, txn, req)?.is_some() {
                return Ok(json!({"ok": true, "pending": true}));
            }
            resolve(priv_fd, &key, txn, req)?;
            retire(priv_fd, &key, txn, req)?;
            json!({"ok": true, "pending": false})
        }
        Ok(None) => return Ok(json!({"ok": false, "owned": true})),
        // Complete absence permits an idempotent ack only, never an inferred publication outcome.
        Err(libc::ENOENT) => json!({"ok": true, "pending": false}),
        Err(_) => return Err(metadata_error(&format!("{key}.{txn}.txn"), "transaction record cannot be locked")),
    };
    // Tests only: the ack is done (no record is left), but its reply does not arrive (smartyfs#37 item 16).
    if test_fault(req, "ackLost") {
        return Err("the ack reply is lost".into());
    }
    Ok(done)
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
    let key = key(req)?;
    let deliveries = match txn_of(entry, &key) {
        Some(txn) => verify_txn_deliveries(priv_fd, &key, &txn, &bytes, req),
        None => Ok(Vec::new()),
    };
    let _deliveries = match deliveries {
        Ok(v) => v,
        Err(e) => { unlock(); return Err(e); }
    };
    let c = cstr(entry)?;
    // SAFETY: prior-delivery bytes have durable helper-private anchors; no delivery namespace can authorize loss.
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
    // Validate ALL evidence before owned-here, outcomes, recovery or age-out can change anything.
    let names = validate_evidence(priv_fd, &key, req)?;
    // Transaction records (#412 rounds 3 to 5): each with its authoritative outcome, and whether this caller may act
    // on its retained data. A live connection's is `owned`; an unowned one is `owned` too unless the caller shows its
    // originating bridge's token (in `tokens`) or it is an old orphan. Outcomes are never omitted: unknown if
    // unreadable. A record goes once no data is left: on its owner's dispose, its bridge's ack, or after 30 days.
    let tokens = &req["tokens"];
    let (_, file_name) = split(req["path"].as_str().ok_or("path")?)?;
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
                    retire(priv_fd, &key, &txn, req)?;
                    continue;
                }
                let state = resolve(priv_fd, &key, &txn, req).map(|s| json!(s)).unwrap_or(json!("unknown"));
                if may_recover(priv_fd, &key, &txn, tokens[txn.as_str()].as_str(), req)? {
                    records.push(json!({"txn": txn, "state": state}));
                } else {
                    // Its origin proven gone, the helper recovers the bytes itself (never a tokenless caller): `orphan`
                    // tells the caller to look again later while a writer still holds them.
                    let waiting = has_data
                        && origin_gone(&required_record(priv_fd, &key, &txn)?, req)
                        && state != json!("unknown")
                        && !recover_orphan(priv_fd, &key, &txn, &file_name, req)?;
                    guarded.insert(txn.clone());
                    records.push(json!({"txn": txn, "state": state, "owned": true, "orphan": waiting}));
                }
            }
            Ok(None) => {
                guarded.insert(txn.clone());
                records.push(json!({"txn": txn, "owned": true}));
            }
            Err(_) => return Err(metadata_error(name, "transaction record cannot be locked")),
        }
    }
    let mut entries = Vec::new();
    for name in names.iter().filter(|n| n.ends_with(".staged")) {
        // Absent only on a confirmed ENOENT (recovered by the helper while this list ran). Any other failure to look
        // at a data entry fails the whole list: a partial list must never read as "no data" (#428 round 3).
        if test_fault(req, "entryStat") {
            return Err("a private entry cannot be inspected".into());
        }
        // Tests only: this list does not see the entry (a stand-in for one whose absence it wrongly confirmed).
        if test_fault(req, "entryHidden") {
            continue;
        }
        if stat_entry(priv_fd, name)?.is_none() {
            continue;
        }
        if let Some(txn) = txn_of(name, &key) { required_record(priv_fd, &key, &txn)?; }
        // Not this caller's to take over: named, but with no bytes (#412 rounds 2 to 5).
        if txn_of(name, &key).is_some_and(|t| guarded.contains(&t)) {
            entries.push(json!({"entry": name, "owned": true}));
            continue;
        }
        let fd = match open_private(priv_fd, name) {
            Ok(fd) => fd,
            Err(libc::ENOENT) => continue,
            Err(e) => return Err(os_err("open", e)),
        };
        if !is_reg(&fstat(fd.as_raw_fd())?) {
            return Err("a private entry is not a regular file".into());
        }
        let bytes = read_all(&fd)?;
        entries.push(json!({"entry": name, "hash": hex(&bytes), "data": B64.encode(&bytes)}));
    }
    // Only verified current copies are fresh recovered deliveries. Valid historical pruned receipts are omitted,
    // not fabricated deliveries. Invalid receipts never expire; retained-byte receipts never age out.
    let mut recovered = Vec::new();
    let current = key_names(priv_fd, &key)?;
    for name in current.iter().filter(|n| n.ends_with(".done")) {
        let (fd, done) = done_info(priv_fd, name, &key)?;
        let staged_prefix = format!("{key}.{}-", done.txn);
        let retained = current.iter().any(|n| n.starts_with(&staged_prefix) && n.ends_with(".staged"));
        let verified = verify_delivery(priv_fd, name, &fd, &done, retained, None, req)?;
        if !retained && now_secs() - fstat(fd.as_raw_fd())?.st_ctime as i64 > ORPHAN_SECS {
            let c = cstr(name)?;
            // SAFETY: schema/binding verified and no retained bytes, never an invalid receipt or unlink authority.
            if unsafe { libc::unlinkat(priv_fd, c.as_ptr(), 0) } != 0 { return Err(metadata_error(name, "cannot retire delivery receipt")); }
            if !fsync(priv_fd) { return Err(metadata_error(name, "receipt retirement cannot be confirmed durable")); }
        } else if verified.is_some() {
            recovered.push(json!({"marker": name, "path": done.path, "hash": done.hash}));
        }
    }
    Ok(json!({"ok": true, "entries": entries, "records": records, "recovered": recovered}))
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
    if peer.is_some() && cred.pid > 0 {
        if let Ok(Some(start)) = process_start(cred.pid) {
            let _ = ORIGIN.set((cred.pid, start));
        }
    }
    if !same_account {
        match peer {
            None => die("stdin must be a socket from the account this helper serves"),
            Some(uid) if uid == euid => die("refusing to serve its own account: the helper must run as its own account (smartyfs#32)"),
            _ if euid == 0 => die("refusing to run as root"),
            _ => {}
        }
    }
    let _ = PEER.set(peer.unwrap_or(euid));
    // SIGIO must terminate us before any further operation; never ignore a notification.
    // SAFETY: configure this process's disposition/mask at startup, before any thread exists.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = libc::SIG_DFL;
        if libc::sigemptyset(&mut action.sa_mask) != 0
            || libc::sigaction(libc::SIGIO, &action, std::ptr::null_mut()) != 0 {
            die(&fail("configure SIGIO disposition"));
        }
        let mut signals: libc::sigset_t = std::mem::zeroed();
        if libc::sigemptyset(&mut signals) != 0
            || libc::sigaddset(&mut signals, libc::SIGIO) != 0
            || libc::sigprocmask(libc::SIG_UNBLOCK, &signals, std::ptr::null_mut()) != 0 {
            die(&fail("unblock SIGIO"));
        }
    }
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
                    Some("hello") => {
                        let rooted: Result<(), String> = match (socket_mode, root_fd, req["root"].as_str()) {
                            (true, None, Some(root)) => admit(root).map(|fd| root_fd = Some(fd)),
                            (true, None, None) => Err("hello needs the root".into()),
                            (true, Some(_), Some(_)) => Err("the root is already set".into()),
                            _ => Ok(()),
                        };
                        // The bridge's recovery directory, once (#428): where the helper delivers recovered orphans.
                        rooted.and_then(|()| match (req["recovery"].as_str(), RECOVERY.get()) {
                            (Some(path), None) => admit_recovery(path, priv_fd, root_fd).map(|fd| {
                                let _ = RECOVERY.set((fd, path.trim_end_matches('/').to_string()));
                            }),
                            _ => Ok(()),
                        })
                        .map(|()| json!({"ok": true, "protocol": 3}))
                    }
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
                // Tests only: the op is done and its lock released, but its reply is late (#436 review round 1).
                test_pause(&req, "beforeReply");
                v
            }
            Err(_) => json!({"ok": false, "error": "invalid json"}),
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() || reply["bye"] == true {
            break;
        }
    }
}
