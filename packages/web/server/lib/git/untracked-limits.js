// Smarty Code (10-26 incident): a project with thousands of untracked files (one scratch folder held 10,747) made
// the web server spawn git per file: `diff --no-index` plus two `cat-file -e` for every untracked path, eight at a
// time, again on every walkthrough read. These bounds keep the per-file paths proportional to what a person can
// look at, not to the size of the working tree.
import path from 'path';

/** Untracked files a status lists one by one; the rest are only counted (`untrackedOmitted`). */
export const MAX_LISTED_UNTRACKED = 200;
/** Untracked files larger than this get no per-file diff. */
export const MAX_UNTRACKED_DIFF_BYTES = 1024 * 1024;
/** Git processes the per-file diff paths may run at once for one project. */
export const MAX_GIT_PER_PROJECT = 4;
const CACHE_MAX_ENTRIES = 2000;
const CACHE_MAX_CHARS = 32 * 1024 * 1024;

// simple-git marks an untracked file '?' in both columns.
const isUntracked = (file) => (file?.index || '').trim() === '?' || (file?.working_dir || '').trim() === '?';

/** Every tracked change, and the first `max` untracked files in git's order; `omitted` counts the rest. */
export function capUntracked(files, max = MAX_LISTED_UNTRACKED) {
  let listed = 0;
  let omitted = 0;
  const kept = files.filter((file) => {
    if (!isUntracked(file)) return true;
    if (listed < max) {
      listed += 1;
      return true;
    }
    omitted += 1;
    return false;
  });
  return { files: kept, omitted };
}

const slots = new Map();

/**
 * Run `task` once fewer than `max` tasks hold a slot for this project; later callers wait in order. A task that
 * spawns git processes one after another holds one slot, so a project never has more than `max` running.
 */
export async function withGitSlot(project, task, max = MAX_GIT_PER_PROJECT) {
  const key = path.resolve(String(project || '.'));
  let entry = slots.get(key);
  if (!entry) {
    entry = { active: 0, waiting: [] };
    slots.set(key, entry);
  }
  if (entry.active >= max) {
    await new Promise((resolve) => entry.waiting.push(resolve)); // The releasing task hands its slot over.
  } else {
    entry.active += 1;
  }
  try {
    return await task();
  } finally {
    const next = entry.waiting.shift();
    if (next) {
      next();
    } else {
      entry.active -= 1;
      if (entry.active === 0) slots.delete(key);
    }
  }
}

const diffs = new Map();
let cachedChars = 0;

/** A file's identity for the cache: its path, and its size and change times (any write changes them). */
export const untrackedDiffKey = (repoRoot, repoPath, stat, contextLines) =>
  [repoRoot, repoPath, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, contextLines].join('\0');

/** An untracked file's diff from an earlier read, while the file is unchanged; else undefined. */
export function cachedUntrackedDiff(key) {
  const value = diffs.get(key);
  if (value !== undefined) {
    diffs.delete(key);
    diffs.set(key, value); // Most recently used last.
  }
  return value;
}

export function cacheUntrackedDiff(key, patch) {
  if (typeof patch !== 'string' || patch.length > CACHE_MAX_CHARS / 4) return;
  const old = diffs.get(key);
  if (old !== undefined) cachedChars -= old.length;
  diffs.delete(key);
  diffs.set(key, patch);
  cachedChars += patch.length;
  while (diffs.size > CACHE_MAX_ENTRIES || cachedChars > CACHE_MAX_CHARS) {
    const [oldest, value] = diffs.entries().next().value;
    diffs.delete(oldest);
    cachedChars -= value.length;
  }
}
