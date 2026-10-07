import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { gitEnvForCaller } from '../security/node-member-execution.js';

/**
 * Node mode (smarty-code#1356): member file writes may not reach Git metadata. Two gaps beyond the `.git` path
 * component check (security/node-member-execution.js):
 *
 * - Alternate Git directory: a `gitdir:` file, a bare repository or GIT_DIR puts metadata at a path with no `.git`
 *   component. `inGitDirectory` asks Git which Git directory governs the target, as Git itself resolves it.
 * - Check-then-write race: a checkout can turn a checked directory into a link into Git metadata before the write.
 *   `openDirectory` opens the checked canonical directory and then names it only through its descriptor
 *   (`/proc/self/fd/N`), so a later swap of any path component cannot redirect the operation.
 *   ponytail: Node has no openat/renameat; Linux's /proc magic links give the same pinning. Other platforms refuse
 *   member writes in Node mode (fail closed) instead of writing unpinned.
 */

const isWithin = (target, root, path) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** True when `target` (canonical) lies in the Git directory Git resolves from its nearest existing directory. */
export const inGitDirectory = async (target, { fsPromises, path, git = 'git' }) => {
  let directory = target;
  while (!(await fsPromises.stat(directory).then((entry) => entry.isDirectory(), () => false))) {
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  // No repository (or no Git) means no Git directory to protect here. A bare repository or one owned by another
  // account still counts: safe.bareRepository (explicit in member Git env) or safe.directory must not hide it from
  // this check; the command-line `-c` wins over both. The probe runs in the caller's Git env (member isolation).
  const args = ['-c', 'safe.bareRepository=all', '-c', 'safe.directory=*', 'rev-parse', '--absolute-git-dir'];
  const gitDir = await new Promise((resolve) => execFile(git, args,
    { cwd: directory, env: gitEnvForCaller(process.env), windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout))));
  if (gitDir === null) return false;
  // Only the line delimiter is removed: a Git directory name may itself end in whitespace. Unparseable output
  // counts as Git metadata (fail closed).
  if (!gitDir.endsWith('\n') || !path.isAbsolute(gitDir.slice(0, -1))) return true;
  const real = await fsPromises.realpath(gitDir.slice(0, -1)).catch(() => gitDir.slice(0, -1));
  return isWithin(target, real, path);
};

const MEMBER_WRITE_NEEDS_LINUX = "Changing files isn't available for members on this Node's platform yet.";

const pin = async (opened, expected, fsPromises) => {
  const handle = await fsPromises.open(opened, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch((error) => { if (['ELOOP', 'ENOTDIR'].includes(error?.code)) return null; throw error; });
  if (!handle) return null;
  const fdPath = `/proc/self/fd/${handle.fd}`;
  // The descriptor's directory must still be the checked one; a moved or replaced directory is refused.
  if (await fsPromises.readlink(fdPath).catch(() => null) !== expected) {
    await handle.close();
    return null;
  }
  return { path: fdPath, at: (name) => `${fdPath}/${name}`, close: () => handle.close() };
};

/** Opens the canonical `directory` (creating missing levels one at a time when `create`) and returns it pinned by
 *  descriptor: `path` for a child's cwd, `at(name)` for an entry in it, `close()`. Null when a level changed after
 *  the check. Throws ENOENT when it is missing and not created. */
export const openDirectory = async (directory, { fsPromises, path, create = false }) => {
  if (process.platform !== 'linux') throw Object.assign(new Error(MEMBER_WRITE_NEEDS_LINUX), { code: 'EPLATFORM' });
  const missing = [];
  let existing = directory;
  while (create && !(await fsPromises.lstat(existing).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }))) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let pinned = await pin(existing, existing, fsPromises);
  for (const name of missing) {
    if (!pinned) return null;
    await fsPromises.mkdir(pinned.at(name)).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
    const next = await pin(pinned.at(name), path.join(existing, name), fsPromises);
    await pinned.close();
    pinned = next;
    existing = path.join(existing, name);
  }
  return pinned;
};
