import nodeFsPromises from 'node:fs/promises';
import nodePath from 'node:path';

// The managed launcher marks its gateway's project list; the same contract the UI reads in
// packages/ui/src/lib/managed-project-catalog.ts (#126 item 8).
const MANAGED_CATALOG_HEADER = 'x-smarty-code-catalog';
const MANAGED_CATALOG_VERSION = 'managed-v1';
const READ_TIMEOUT_MS = 5000;

// Same row rules as the UI parser: absolute, no control bytes, no dot segments. `path.isAbsolute`
// throws on a non-string value, which the caller treats as an unreadable catalog.
const isCatalogDirectory = (value, path) => path.isAbsolute(value)
  // eslint-disable-next-line no-control-regex -- Reject control bytes in native catalog paths.
  && !/[\u0000-\u001f]/.test(value)
  && !value.split(/[\\/]/).some((part) => part === '.' || part === '..');

/** Reads the live managed rows from the OpenCode gateway on each check; no cache, no timer. */
export const createManagedCatalogReader = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetch = globalThis.fetch,
  fsPromises = nodeFsPromises,
  path = nodePath,
}) => {
  const readLiveDirectories = async () => {
    const response = await fetch(buildOpenCodeUrl('/project', ''), {
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok || response.headers.get(MANAGED_CATALOG_HEADER) !== MANAGED_CATALOG_VERSION) {
      throw new Error('Managed project catalog unavailable');
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || !rows.every((row) => isCatalogDirectory(row?.worktree, path))) {
      throw new Error('Malformed managed project catalog');
    }
    return rows.map((row) => row.worktree);
  };

  // Real path when it exists, else the lexical absolute path; both drop trailing slashes.
  const canonical = async (directory) => path.resolve(await fsPromises.realpath(directory).catch(() => directory));

  /** True when the directory is a live managed row. Throws when the catalog cannot be read. */
  const isLiveDirectory = async (directory) => {
    if (!directory?.trim()) return false;
    const [target, live] = await Promise.all([
      canonical(directory.trim()),
      readLiveDirectories().then((rows) => Promise.all(rows.map(canonical))),
    ]);
    return live.includes(target);
  };

  return { isLiveDirectory };
};
