import { getDiff, getRangeDiff, getUntrackedDiffs, listUntrackedPaths } from '../git/service.js';
import { MAX_LISTED_UNTRACKED } from '../git/untracked-limits.js';

// A walkthrough source resolves to one or more diff *sections*. A section is a
// patch plus the scope its hunk ids live in; keeping staged and working-tree
// changes in separate scopes means a stop written against staged code never
// silently re-anchors onto an unstaged edit of the same lines.

const WORKING_TREE_SCOPES = new Set(['all', 'staged', 'working']);

export class WalkthroughSourceError extends Error {
  constructor(message, statusCode = 400, code = undefined) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

/**
 * Normalize and validate an untrusted source descriptor from the client.
 */
export function parseSource(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new WalkthroughSourceError('source is required');
  }

  if (raw.kind === 'working-tree') {
    const scope = typeof raw.scope === 'string' ? raw.scope : 'all';
    if (!WORKING_TREE_SCOPES.has(scope)) {
      throw new WalkthroughSourceError(`Unknown working-tree scope "${scope}"`);
    }
    return { kind: 'working-tree', scope };
  }

  if (raw.kind === 'branch') {
    const baseRef = typeof raw.baseRef === 'string' ? raw.baseRef.trim() : '';
    const headRef = typeof raw.headRef === 'string' ? raw.headRef.trim() : '';
    if (!baseRef || !headRef) {
      throw new WalkthroughSourceError('branch sources require baseRef and headRef');
    }
    return { kind: 'branch', baseRef, headRef };
  }

  if (raw.kind === 'pr') {
    const number = Number(raw.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw new WalkthroughSourceError('pr sources require a positive number');
    }
    return { kind: 'pr', number };
  }

  throw new WalkthroughSourceError(`Unknown source kind "${String(raw.kind)}"`);
}

/**
 * Stable string form of a source, used as the pointer key and as part of the
 * cache key. Must not change shape casually — it addresses persisted files.
 */
export function sourceKey(source) {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  return `pr:${source.number}`;
}

// `git diff` never reports untracked files, so a brand-new file would be
// invisible in a walkthrough of local work. The batch helper resolves the
// repository once and bounds how many diff processes run at a time. Only the
// first untracked files are read (as the Changes list): a scratch folder of
// thousands must not cost a git process per file on every read. What is left
// out is never silent (digest.js): its count and first paths go in meta, and
// the walkthrough view says so.
const OMITTED_PATHS_SHOWN = 50;
const untrackedSections = async (directory) => {
  const all = await listUntrackedPaths(directory);
  const untracked = all.slice(0, MAX_LISTED_UNTRACKED);
  const omitted = all.slice(MAX_LISTED_UNTRACKED).map((path) => ({ path, reason: 'cap' }));
  if (untracked.length === 0) return { patches: [], omitted };

  const tooLarge = [];
  const patches = await getUntrackedDiffs(directory, untracked, { onSkip: (path, reason) => tooLarge.push({ path, reason }) });
  return { patches: patches.filter((patch) => typeof patch === 'string' && patch.trim()), omitted: [...tooLarge, ...omitted] };
};

/** meta.untrackedOmitted: how many untracked files the working-tree source left out, and the first of them. */
const omittedMeta = (omitted) => (omitted.length === 0 ? {} : {
  untrackedOmitted: { count: omitted.length, paths: omitted.slice(0, OMITTED_PATHS_SHOWN), limit: MAX_LISTED_UNTRACKED },
});

/**
 * Resolve a source into diff sections.
 *
 * @returns {Promise<{sections: Array<{scope: string, patch: string}>, meta: object}>}
 */
export async function loadSourceSections(directory, source, { getPullRequestDiff } = {}) {
  if (source.kind === 'working-tree') {
    const sections = [];
    let omitted = [];

    if (source.scope === 'all' || source.scope === 'staged') {
      const patch = await getDiff(directory, { staged: true });
      if (patch && patch.trim()) sections.push({ scope: 'staged', patch });
    }

    if (source.scope === 'all' || source.scope === 'working') {
      const patch = await getDiff(directory, { staged: false });
      const untracked = await untrackedSections(directory);
      omitted = untracked.omitted;
      const combined = [patch, ...untracked.patches].filter((value) => value && value.trim()).join('\n');
      if (combined.trim()) sections.push({ scope: 'working', patch: combined });
    }

    return { sections, meta: omittedMeta(omitted) };
  }

  if (source.kind === 'branch') {
    const patch = await getRangeDiff(directory, { base: source.baseRef, head: source.headRef });
    return {
      sections: patch && patch.trim() ? [{ scope: 'branch', patch }] : [],
      meta: { baseRef: source.baseRef, headRef: source.headRef },
    };
  }

  if (typeof getPullRequestDiff !== 'function') {
    throw new WalkthroughSourceError('Pull request diffs are unavailable', 500);
  }

  const { patch, meta } = await getPullRequestDiff(directory, source.number);
  return {
    sections: patch && patch.trim() ? [{ scope: `pr:${source.number}`, patch }] : [],
    meta: meta || {},
  };
}
