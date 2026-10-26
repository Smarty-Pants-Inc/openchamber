// Smarty Code (10-26 incident): a project with 10,000+ untracked files. The Changes request and the walkthrough's
// working-tree read stay fast and spawn a bounded number of git processes, never one per untracked file; per-file
// diffs never run more than MAX_GIT_PER_PROJECT git processes at once. A `git` first on PATH records each process
// start and end, in order, and runs the real git.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getFileDiff, getStatus, getUntrackedDiffs } from './service.js';
import { loadSourceSections } from '../walkthrough/sources.js';
import { MAX_GIT_PER_PROJECT, MAX_LISTED_UNTRACKED, capUntracked, withGitSlot } from './untracked-limits.js';

const UNTRACKED = 10_500;
const realGit = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'git')).find((file) => fs.existsSync(file));
const saved = { PATH: process.env.PATH, REAL_GIT: process.env.REAL_GIT, GIT_SPAWN_LOG: process.env.GIT_SPAWN_LOG };
let root;
let repo;
let log;

/** Git processes since the last call: how many started, and the most running at once. */
const spawns = () => {
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  fs.writeFileSync(log, '');
  let running = 0;
  let peak = 0;
  for (const line of lines) {
    running += line === '+' ? 1 : -1;
    peak = Math.max(peak, running);
  }
  return { started: lines.filter((line) => line === '+').length, peak };
};

const timed = async (task) => {
  const start = performance.now();
  const value = await task();
  return { value, ms: performance.now() - start };
};
/** The fastest of three runs, after a warm-up (as a server that polls has its caches warm). */
const best = async (task) => {
  await task();
  let ms = Infinity;
  for (let i = 0; i < 3; i += 1) ms = Math.min(ms, (await timed(task)).ms);
  return ms;
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-untracked-'));
  repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, 'scratch'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty'));
  fs.mkdirSync(bin);
  log = path.join(root, 'spawns.log');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho + >> "$GIT_SPAWN_LOG"\n"$REAL_GIT" "$@"\ncode=$?\necho - >> "$GIT_SPAWN_LOG"\nexit $code\n', { mode: 0o755 });
  const git = (...args) => execFileSync(realGit, args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  git('add', 'tracked.txt');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n'); // One tracked change.
  execFileSync(realGit, ['init', '-q', '-b', 'main'], { cwd: path.join(root, 'empty'), stdio: 'ignore' }); // The baseline.
  for (let i = 0; i < UNTRACKED; i += 1) fs.writeFileSync(path.join(repo, 'scratch', `note-${String(i).padStart(5, '0')}.txt`), `note ${i}\n`);
  fs.writeFileSync(path.join(repo, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 120)); // Over the diff size cap.
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${saved.PATH}`, REAL_GIT: realGit, GIT_SPAWN_LOG: log });
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(Boolean(realGit))('a project with 10,000+ untracked files', () => {
  it('the Changes request lists every tracked change and 200 untracked files, counts the rest, and is fast', async () => {
    // Its cost is a fixed set of git calls (about 200 ms on a near-empty repository on a busy host); 10,000+ untracked
    // files may add at most 150 ms to it.
    const baseline = await best(() => getStatus(path.join(root, 'empty')));
    const ms = await best(() => getStatus(repo));
    spawns();
    const status = await getStatus(repo);
    const counted = spawns();
    expect(status.files.filter((file) => file.working_dir === '?')).toHaveLength(MAX_LISTED_UNTRACKED);
    expect(status.files.some((file) => file.path === 'tracked.txt')).toBe(true);
    expect(status.untrackedOmitted).toBe(UNTRACKED + 1 - MAX_LISTED_UNTRACKED);
    console.info(`[untracked] status: ${ms.toFixed(0)} ms (empty repository ${baseline.toFixed(0)} ms), ${counted.started} git processes, at most ${counted.peak} at once, ${JSON.stringify(status).length} bytes`);
    expect(counted.started).toBeLessThanOrEqual(20); // A fixed set of git calls (14 today), none per file.
    expect(counted.peak).toBeLessThanOrEqual(MAX_GIT_PER_PROJECT);
    expect(ms).toBeLessThan(baseline + 150);
    expect(JSON.stringify(status).length).toBeLessThan(64 * 1024); // Before: 683 KB of rows.
    const light = await getStatus(repo, { mode: 'light' });
    expect(light.files).toHaveLength(status.files.length);
    expect(light.untrackedOmitted).toBe(status.untrackedOmitted);
  });

  it('the walkthrough reads at most 200 untracked files, K git processes at a time, and nothing again when unchanged', async () => {
    spawns();
    const first = await timed(() => loadSourceSections(repo, { kind: 'working-tree', scope: 'working' }));
    const counted = spawns();
    console.info(`[untracked] walkthrough: ${first.ms.toFixed(0)} ms, ${counted.started} git processes, at most ${counted.peak} at once`);
    expect(counted.started).toBeLessThanOrEqual(MAX_LISTED_UNTRACKED + 10); // Before: 3 per untracked file (31,500).
    expect(counted.peak).toBeLessThanOrEqual(MAX_GIT_PER_PROJECT);
    expect(first.value.sections[0].patch).toContain('scratch/note-00000.txt');
    expect(first.value.sections[0].patch).not.toContain(`note-${String(MAX_LISTED_UNTRACKED).padStart(5, '0')}`);
    const again = await timed(() => loadSourceSections(repo, { kind: 'working-tree', scope: 'working' }));
    expect(again.value).toEqual(first.value);
    expect(spawns().started).toBeLessThanOrEqual(10); // The untracked diffs come from the cache.
    fs.writeFileSync(path.join(repo, 'scratch', 'note-00001.txt'), 'changed\n');
    const changed = await loadSourceSections(repo, { kind: 'working-tree', scope: 'working' });
    expect(changed.sections[0].patch).toContain('+changed');
    expect(spawns().started).toBeLessThanOrEqual(11); // Only the changed file is diffed again.
  });

  it('an untracked file over the size cap gets no diff and no git process', async () => {
    spawns();
    expect(await getUntrackedDiffs(repo, ['big.bin'])).toEqual(['']);
    expect(spawns().started).toBeLessThanOrEqual(2); // Resolving the repository only.
  });

  it('a burst of per-file diff requests runs at most K git processes at once', async () => {
    spawns();
    const paths = Array.from({ length: 24 }, (_, i) => `scratch/note-${String(5000 + i).padStart(5, '0')}.txt`);
    const results = await Promise.all(paths.map((file) => getFileDiff(repo, { path: file })));
    expect(results.map((result) => result.modified)).toEqual(paths.map((_, i) => `note ${5000 + i}\n`));
    expect(spawns().peak).toBeLessThanOrEqual(MAX_GIT_PER_PROJECT);
  });
});

describe('untracked limits', () => {
  it('capUntracked keeps tracked changes and counts the untracked past the cap', () => {
    const files = [{ path: 'a', index: '?', working_dir: '?' }, { path: 'm', index: ' ', working_dir: 'M' },
      { path: 'b', index: '?', working_dir: '?' }, { path: 'c', index: '?', working_dir: '?' }];
    expect(capUntracked(files, 1)).toEqual({ files: [files[0], files[1]], omitted: 2 });
  });

  it('withGitSlot runs at most max tasks per project, in order, and other projects are not held', async () => {
    const order = [];
    let running = 0;
    let peak = 0;
    const task = (name) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(name);
      running -= 1;
      return name;
    };
    const other = withGitSlot('/other', task('other'), 1);
    const names = await Promise.all(['a', 'b', 'c', 'd'].map((name) => withGitSlot('/p', task(name), 2)));
    expect(names).toEqual(['a', 'b', 'c', 'd']);
    expect(await other).toBe('other');
    expect(peak).toBeLessThanOrEqual(3); // 2 for /p, 1 for /other.
    expect(order.indexOf('c')).toBeGreaterThan(Math.min(order.indexOf('a'), order.indexOf('b')));
  });
});
