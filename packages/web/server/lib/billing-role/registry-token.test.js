import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// smarty-net#136 L3 (security pass on openchamber#339): the registry token never reaches a child of the web server.
// A fake canary token goes in; each child reports only whether the canary is visible, never the value.
const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '../..');
const canary = `canary-${process.pid}-${Date.now()}`;
const probe = (runtime, code) => execFileSync(runtime, runtime === 'bun' ? ['-e', code] : ['--input-type=module', '-e', code],
  { cwd: server, env: { ...process.env, NODE_REGISTRY_TOKEN: canary }, encoding: 'utf8', timeout: 60_000 }).trim();
// The child: load the module as the server does, then spawn children the ways the server does (an inherited
// environment, an explicit copy of process.env, and under Bun its native environ) and report "seen"/"clean".
const child = (extra = '') => `
  const { registryToken } = await import('./lib/billing-role/registry-token.js');
  const { execSync } = await import('node:child_process');
  const c = ${JSON.stringify(canary)}, out = [];
  out.push(registryToken() === c ? 'kept' : 'lost');
  out.push(execSync('env').toString().includes(c) ? 'seen' : 'clean');
  out.push(execSync('env', { env: { ...process.env } }).toString().includes(c) ? 'seen' : 'clean');
  ${extra}
  console.log(out.join(' '));`;

describe('registry token containment', () => {
  it('Node: the server keeps it; inherited and copied child environments do not have it', () => {
    expect(probe('node', child())).toBe('kept clean clean');
  });

  it('Bun: also its native environ, which a bun-pty terminal merges', () => {
    const out = probe('bun', child(`
      const { spawn } = await import('bun-pty');
      const pty = spawn('/bin/sh', ['-c', 'env'], { name: 'xterm', cols: 200, rows: 50, cwd: '/', env: { ...process.env } });
      let text = ''; pty.onData((d) => { text += d; });
      await new Promise((resolve) => pty.onExit(resolve));
      out.push(text.includes(c) ? 'seen' : 'clean');`));
    expect(out).toBe('kept clean clean clean');
  });

  it('fails closed: when the native removal cannot load or does not succeed, startup stops; with no token nothing is needed', async () => {
    const { takeRegistryToken } = await import('./registry-token.js');
    expect(() => takeRegistryToken({ NODE_REGISTRY_TOKEN: 'x' }, () => { throw new Error('no bun:ffi'); })).toThrow(/not starting/);
    expect(() => takeRegistryToken({ NODE_REGISTRY_TOKEN: 'x' }, () => () => -1)).toThrow(/not starting/);
    expect(() => takeRegistryToken({ NODE_REGISTRY_TOKEN: 'x' }, () => undefined)).toThrow(/not starting/);
    const env = { NODE_REGISTRY_TOKEN: 'x' };
    expect(takeRegistryToken(env, () => () => 0)).toBe('x'); expect(env.NODE_REGISTRY_TOKEN).toBeUndefined();
    expect(takeRegistryToken({ NODE_REGISTRY_TOKEN: 'x' }, () => null)).toBe('x'); // Node: the JS delete is the real one
    expect(takeRegistryToken({}, () => { throw new Error('never asked'); })).toBe('');
  });

  it('the server never uses Bun.spawn with its default environment (Bun keeps its own start-up copy of it)', () => {
    // The server's own sources (a file walk, not git: CI copies may have no .git).
    const files = readdirSync(server, { recursive: true }).map(String)
      .filter((f) => f.endsWith('.js') && !f.includes('.test.') && !f.split('/').includes('node_modules'));
    expect(files.filter((f) => /Bun\.spawn/.test(readFileSync(join(server, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')))).toEqual([]);
  });

  it('it is taken before the server body copies the environment: static imports from index.js lead to it', () => {
    // ES modules finish loading before index.js's body runs its login-shell snapshot (line ~752) or starts any child.
    const imports = (file, target) => new RegExp(`^import [^;]*from '${target.replace(/[.]/g, '\\.')}';`, 'm').test(readFileSync(join(server, file), 'utf8'));
    expect(imports('index.js', './lib/opencode/bootstrap-runtime.js')).toBe(true);
    expect(imports('lib/opencode/bootstrap-runtime.js', '../billing-role/billing-role.js')).toBe(true);
    expect(imports('lib/billing-role/billing-role.js', './registry-token.js')).toBe(true);
  });
});
