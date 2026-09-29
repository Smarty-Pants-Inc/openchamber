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

/// The private entries this connection owns (#412 round 2, finding 1): each held open with an exclusive flock from the
/// moment the entry exists until this connection's own dispose removes it, or this process ends. Another connection
/// sees such an entry only as owned by a live connection: it cannot read, dispose or recover it. Once the owner's
/// process is gone (its bridge closed or crashed) the lock is released and the entry is an orphan anyone may recover.
type Owned = std::collections::HashMap<String, OwnedFd>;

/// Takes ownership of a private entry: Some(fd holding its flock), or None while another live connection owns it.
fn lock_entry(priv_fd: RawFd, name: &str) -> Result<Option<OwnedFd>, i32> {
    let fd = open_private(priv_fd, name)?;
    // SAFETY: flock on our own fd.
    if unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(fd));
    }
    match errno() {
        libc::EWOULDBLOCK => Ok(None),
        e => Err(e),
    }
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
    if rest.is_empty() || e.contains('/') || e.contains('\0') || rest.starts_with('.') {
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
    let txn = req["txn"].as_str().unwrap_or("");
    if txn.len() > 32 || !txn.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("invalid txn".into());
    }
    let staged = if txn.is_empty() { format!("{key}.{}.staged", unique()) } else { format!("{key}.{txn}-{}.staged", unique()) };
    let staged_c = cstr(&staged)?;
    let proc_path = CString::new(format!("/proc/self/fd/{}", tmp.as_raw_fd())).unwrap();
    // SAFETY: links our unnamed inode (through its fd) under a fresh private name; EEXIST if taken.
    if unsafe { libc::linkat(libc::AT_FDCWD, proc_path.as_ptr(), priv_fd, staged_c.as_ptr(), libc::AT_SYMLINK_FOLLOW) } != 0 {
        return Err(fail("linkat"));
    }
    // SAFETY: unlinks our own private entry (nothing was published).
    let unlink_staged = || unsafe { libc::unlinkat(priv_fd, staged_c.as_ptr(), 0) };
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
    // 7. Published: from here the private entry holds the displaced object, and nothing is undone.
    test_pause(req, "afterExchange");
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
    // This connection owns the displaced entry until its own dispose: taken before the file's lock is released, so no
    // other connection ever sees it unowned while this one lives.
    if let Ok(Some(fd)) = lock_entry(priv_fd, &staged) {
        owned.insert(staged.clone(), fd);
    }
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
    let _lock = lock_key(priv_fd, &key(req)?)?;
    let hash = req["hash"].as_str().ok_or("hash")?;
    // Ours already, or an orphan taken over now; another live connection's entry is refused, never touched.
    let fd = match owned.remove(&entry) {
        Some(fd) => fd,
        None => match lock_entry(priv_fd, &entry) {
            Ok(Some(fd)) => fd,
            Ok(None) => return Ok(json!({"ok": false, "owned": true})),
            Err(libc::ENOENT) => return Ok(json!({"ok": true})),
            Err(e) => return Err(os_err("open", e)),
        },
    };
    let result = dispose_entry(priv_fd, req, &entry, hash, &fd);
    // Still there (busy, late bytes, an error): this connection keeps owning it.
    if !matches!(&result, Ok(v) if v["ok"] == true) {
        owned.insert(entry, fd);
    }
    result
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
    let mut entries = Vec::new();
    for e in std::fs::read_dir(format!("/proc/self/fd/{priv_fd}")).map_err(|e| e.to_string())? {
        let name = e.map_err(|e| e.to_string())?.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) {
            continue;
        }
        if name.ends_with("-lock") {
            continue;
        }
        // Another live connection's entry: named, but with no bytes to take over (#412 round 2, finding 1).
        let held;
        let fd = match owned.get(&name) {
            Some(fd) => fd,
            None => match lock_entry(priv_fd, &name) {
                Ok(Some(fd)) => {
                    held = fd;
                    &held
                }
                Ok(None) => {
                    entries.push(json!({"entry": name, "owned": true}));
                    continue;
                }
                Err(_) => continue,
            },
        };
        if !fstat(fd.as_raw_fd()).map(|s| is_reg(&s)).unwrap_or(false) {
            continue;
        }
        let bytes = read_all(fd)?;
        entries.push(json!({"entry": name, "hash": hex(&bytes), "data": B64.encode(&bytes)}));
    }
    Ok(json!({"ok": true, "entries": entries}))
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
                    Some("read" | "publish" | "flush" | "list" | "dispose") if root_fd.is_none() => Err("hello with the root first".into()),
                    Some("read") => read_op(root_fd.unwrap_or(-1), &req),
                    Some("publish") => publish_op(root_fd.unwrap_or(-1), priv_fd, &req, &mut unsynced, &mut owned),
                    Some("flush") => flush_op(root_fd.unwrap_or(-1), priv_fd, &req, &mut unsynced),
                    Some("dispose") => dispose_op(priv_fd, &req, &mut owned),
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
