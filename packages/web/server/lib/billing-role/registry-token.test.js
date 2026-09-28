import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { takeRegistryToken } from './registry-token.js';

// smarty-net#136 L3 (security passes on openchamber#339): the registry token never reaches a child of the web server.
// A fake canary token goes in; each child reports only whether the canary is visible, never the value.
const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '../..');
const canary = `canary-${process.pid}-${Date.now()}`;
const env = { ...process.env, NODE_REGISTRY_TOKEN: canary };
// The child loads the module as the server does, then spawns children the ways the server does: an inherited
// environment and an explicit copy of process.env. It prints "seen"/"clean" per child.
const child = `
  const { registryToken } = await import('./lib/billing-role/registry-token.js');
  const { execSync } = await import('node:child_process');
  const c = ${JSON.stringify(canary)}, out = [];
  out.push(registryToken() === c ? 'kept' : 'lost');
  out.push(execSync('env').toString().includes(c) ? 'seen' : 'clean');
  out.push(execSync('env', { env: { ...process.env } }).toString().includes(c) ? 'seen' : 'clean');
  console.log(out.join(' '));`;

describe('registry token containment', () => {
  it('Node: the server keeps it; inherited and copied child environments do not have it', () => {
    expect(execFileSync('node', ['--input-type=module', '-e', child], { cwd: server, env, encoding: 'utf8', timeout: 60_000 }).trim())
      .toBe('kept clean clean');
  });

  it('Bun: a server given the token does not start (Bun hands children its start-up environment)', () => {
    const run = spawnSync('bun', ['-e', child], { cwd: server, env, encoding: 'utf8', timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('kept');
    expect(run.stderr).toContain('run this server under Node');
    expect(run.stderr).not.toContain(canary);
  });

  it('the rule itself: taken from the environment; refused under Bun only when a token was given', () => {
    const plain = { NODE_REGISTRY_TOKEN: 'x' };
    expect(takeRegistryToken(plain, false)).toBe('x'); expect(plain.NODE_REGISTRY_TOKEN).toBeUndefined();
    expect(() => takeRegistryToken({ NODE_REGISTRY_TOKEN: 'x' }, true)).toThrow(/under Node/);
    expect(takeRegistryToken({}, true)).toBe('');
  });

  it('it is taken before the server body copies the environment: static imports from index.js lead to it', () => {
    // ES modules finish loading before index.js's body runs its login-shell snapshot (line ~752) or starts any child.
    const imports = (file, target) => new RegExp(`^import [^;]*from '${target.replace(/[.]/g, '\\.')}';`, 'm').test(readFileSync(join(server, file), 'utf8'));
    expect(imports('index.js', './lib/opencode/bootstrap-runtime.js')).toBe(true);
    expect(imports('lib/opencode/bootstrap-runtime.js', '../billing-role/billing-role.js')).toBe(true);
    expect(imports('lib/billing-role/billing-role.js', './registry-token.js')).toBe(true);
  });
});
