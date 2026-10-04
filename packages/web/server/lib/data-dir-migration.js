// One-time copy of the user-authored folders into a custom data directory.
//
// `OPENCHAMBER_DATA_DIR` is documented as "the OpenChamber data directory",
// but for a long time only the flat files (settings, auth, push tokens)
// followed it while `projects/`, `themes/`, and `speech-models/` stayed under
// `~/.config/openchamber`. Now every folder hangs off the data directory, so an
// instance that already ran with a custom directory finds those folders in
// the old place. This copies each one over once: only when the new location
// does not exist yet and the old one does. It copies rather than moves
// because a second instance on the same machine (a custom directory next to
// the default one) must not strip the default instance of its projects.

const USER_DIR_ENTRIES = Object.freeze(['projects', 'themes', 'speech-models']);

const exists = async (fsPromises, target) => fsPromises.access(target).then(() => true, () => false);

/**
 * Copy the user folders from `legacyRoot` into `dataDir`. Returns the entries
 * copied. A no-op when the two roots are the same directory. A folder whose
 * copy fails is reported through `warn`; the server keeps starting. Partial
 * copies are retained and skipped on later starts: another instance may have
 * already written new data there, so removing the final directory is unsafe.
 * On POSIX, newly created roots and destinations are private from creation;
 * existing roots and destinations keep their permissions. Child file modes
 * are preserved, with privacy supplied by the destination directory. Copying
 * needs owner write access temporarily, then intersects destination owner bits
 * with the source's, even on failure. Windows mode bits do not qualify privacy
 * or ACL preservation. Arbitrary external directory replacement is not guarded.
 */
export const migrateLegacyUserDirs = async ({ fsPromises, path, dataDir, legacyRoot, warn = () => {}, entries = USER_DIR_ENTRIES }) => {
  if (path.resolve(dataDir) === path.resolve(legacyRoot)) return [];
  const moved = [];
  for (const entry of entries) {
    const from = path.join(legacyRoot, entry);
    const to = path.join(dataDir, entry);
    if (await exists(fsPromises, to) || !(await exists(fsPromises, from))) continue;
    try {
      await fsPromises.mkdir(dataDir, { recursive: true, mode: 0o700 });
      try {
        // Only the instance that creates the destination may migrate into it.
        await fsPromises.mkdir(to, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
      const sourceMode = process.platform === 'win32' ? 0o700 : (await fsPromises.stat(from)).mode & 0o700;
      try {
        // Copy children because errorOnExist also rejects our owned root directory.
        for (const child of await fsPromises.readdir(from)) {
          await fsPromises.cp(path.join(from, child), path.join(to, child), { recursive: true, errorOnExist: true, force: false });
        }
      } finally {
        if (sourceMode !== 0o700) {
          const destinationMode = (await fsPromises.stat(to)).mode & 0o700;
          const restrictedMode = destinationMode & sourceMode;
          if (restrictedMode !== destinationMode) await fsPromises.chmod(to, restrictedMode);
        }
      }
      moved.push(entry);
    } catch (error) {
      warn(`Failed to copy ${from} to ${to}: ${error instanceof Error ? error.message : String(error)}; any partial destination is retained and will be skipped on later starts.`);
    }
  }
  return moved;
};
