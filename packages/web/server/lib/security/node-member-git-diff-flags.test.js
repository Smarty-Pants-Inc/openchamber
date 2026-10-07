import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getDiff } from '../git/service.js';
import { runAsMember } from './node-member-execution.js';

/** The last source of a diff helper once system and global config are off: a repository's own .git/config (written by
 *  the owner). In Node mode the server's diff passes --no-ext-diff and --no-textconv, so neither runs. */
const helperRunsOnDiff = async (caller, localConfig) => {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'node-git-diff-flags-')), repo = join(root, 'repo'), marker = join(root, 'ran');
  try {
    const helper = join(root, 'helper.sh');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\ncat \"$1\" 2>/dev/null\n`); chmodSync(helper, 0o755);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    mkdirSync(repo); git('init', '-q'); git('config', 'user.name', 'f'); git('config', 'user.email', 'f@example.test');
    for (const [key, value] of localConfig(helper)) git('config', key, value);
    writeFileSync(join(repo, '.gitattributes'), '*.t diff=tx filter=fx\n'); writeFileSync(join(repo, 'a.t'), '1\n');
    git('add', '.'); git('commit', '-q', '-m', 'init');
    rmSync(marker, { force: true }); // the owner's own setup commit may run the filter
    writeFileSync(join(repo, 'a.t'), '2\n');
    Object.assign(process.env, { HOME: root, GIT_CONFIG_NOSYSTEM: '1' });
    if (caller === 'no Node') delete process.env.SMARTY_CODE_NODE_ID; else process.env.SMARTY_CODE_NODE_ID = 'fixture-node';
    const diff = () => getDiff(repo, { path: 'a.t' }).catch(() => null);
    await (caller === 'member' ? runAsMember(diff) : diff());
    return existsSync(marker);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
};
const external = helper => [['diff.external', helper]];
const textconv = helper => [['diff.tx.textconv', helper]];
/** A repository's own config that includes another file defining a filter; `.gitattributes` selects it. */
const includedFilter = (helper) => {
  const extra = join(dirname(helper), 'extra.cfg');
  writeFileSync(extra, `[filter "fx"]\n\tclean = ${helper}\n`);
  return [['include.path', extra]];
};

it('Node member: a repository diff.external does not run on the server diff', async () => {
  expect(await helperRunsOnDiff('member', external)).toBe(false);
});
it('Node member: a repository textconv does not run on the server diff', async () => {
  expect(await helperRunsOnDiff('member', textconv)).toBe(false);
});
it('Node member: a filter from a repository include does not run on the server diff', async () => {
  expect(await helperRunsOnDiff('member', includedFilter)).toBe(false);
});
for (const caller of ['Node owner', 'no Node']) {
  it(`${caller}: repository diff.external, textconv and an included filter still run on the server diff`, async () => {
    expect([await helperRunsOnDiff(caller, external), await helperRunsOnDiff(caller, textconv),
      await helperRunsOnDiff(caller, includedFilter)]).toEqual([true, true, true]);
  });
}
