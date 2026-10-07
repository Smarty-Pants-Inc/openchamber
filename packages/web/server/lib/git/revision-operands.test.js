import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getCommitFileDiff, getCommitFiles, getLog, getRangeDiff, getRangeFiles } from './service.js';

/** Revision inputs come from the request (Git read routes a Node member may call). A value that Git would parse as an
 *  option (`--output=<file>` writes a file as the server account) must be refused before any Git child sees it. */
let root, repo, head;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'git-revision-operands-')); repo = join(root, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main', repo);
  const inRepo = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim();
  inRepo('config', 'user.name', 'f'); inRepo('config', 'user.email', 'f@example.test');
  writeFileSync(join(repo, 'a.txt'), '1\n'); inRepo('add', '.'); inRepo('commit', '-q', '-m', 'one');
  writeFileSync(join(repo, 'a.txt'), '2\n'); inRepo('commit', '-q', '-am', 'two');
  head = inRepo('rev-parse', 'HEAD');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const calls = [
  ['commit-files hash', target => getCommitFiles(repo, `--output=${target}`)],
  ['commit-file-diff hash', target => getCommitFileDiff(repo, `--output=${target}`, 'a.txt', false)],
  ['log to', target => getLog(repo, { to: `--output=${target}` })],
  ['log from', target => getLog(repo, { from: `--output=${target}` })],
  ['range-diff head', target => getRangeDiff(repo, { base: 'main', head: `--output=${target}` })],
  ['range-diff base', target => getRangeDiff(repo, { base: `--output=${target}`, head: 'main' })],
  ['range-files head', target => getRangeFiles(repo, { base: 'main', head: `--output=${target}` })],
  ['range-files base', target => getRangeFiles(repo, { base: `--output=${target}`, head: 'main' })],
];
for (const [name, call] of calls) {
  it(`${name}: an option-shaped revision is refused and writes nothing`, async () => {
    const target = join(root, `written-${name.replace(/\W+/g, '-')}`);
    await expect(call(target)).rejects.toThrow(/Invalid revision/);
    expect(existsSync(target)).toBe(false);
  });
}

it('ordinary revisions still work', async () => {
  expect((await getCommitFiles(repo, head)).files.map(file => file.path)).toEqual(['a.txt']);
  expect((await getCommitFileDiff(repo, head, 'a.txt', false)).modified).toBe('2\n');
  expect((await getLog(repo, {})).all).toHaveLength(2);
  expect((await getLog(repo, { from: 'main~1' })).all.map(entry => entry.hash)).toEqual([head]);
  expect((await getRangeFiles(repo, { base: 'main~1', head: 'main' })).files ?? []).toBeTruthy();
});
