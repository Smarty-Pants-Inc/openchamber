import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { OpenCodeManager } from './opencode';
import { waitForApiUrl } from './opencode-ready';
import { getOpenCodeUpgradeStatus, upgradeManagedOpenCode } from './opencode-upgrade-runtime';

const require = createRequire(import.meta.url);

function fixture(apiUrl = '') {
  const effects = { reap: 0, cli: 0, read: 0, cwd: 0, port: 0, spawn: 0, registry: 0, signal: 0 };
  const env = {
    PATH: '', OPENCODE_BINARY: '/explicit/opencode',
    OPENCODE_SERVER_PASSWORD: 'fixture-only-password',
    OPENCODE_SERVER_USERNAME: 'fixture-user',
  };
  const initialEnv = { ...env };
  const configuration = {
    get: (key: string) => key === 'apiUrl' ? apiUrl : key === 'opencodeBinary' ? '/explicit/opencode' : undefined,
  };
  const load = (file: string) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    return runInNewContext(`${code}\nmodule.exports;`, {
      module, exports: module.exports,
      require: (id: string) => {
        if (id === 'vscode') return {
          workspace: { getConfiguration: () => configuration, workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
          l10n: { t: (message: string, ...args: Array<string | number | boolean>) => message.replace(/\{(\d+)\}/g, (_match, index) => String(args[Number(index)])) },
          Disposable: class { constructor(public dispose: () => void) {} },
        };
        if (id === 'fs') return {
          readFileSync: () => { effects.read += 1; throw new Error('No shared settings fixture'); },
          statSync: () => { effects.cli += 1; throw new Error('No CLI fixture'); },
          mkdirSync: () => { effects.cwd += 1; },
        };
        if (id === 'net') return {
          createServer: () => { effects.port += 1; throw new Error('PORT_ALLOCATION_REACHED'); },
        };
        if (id === 'child_process' || id === 'node:child_process') return {
          spawn: () => { effects.spawn += 1; throw new Error('CHILD_SPAWN_REACHED'); },
          spawnSync: () => { effects.cli += 1; throw new Error('CLI_PROBE_REACHED'); },
          execFile: () => { effects.signal += 1; throw new Error('TREE_TERMINATION_REACHED'); },
        };
        if (id === './opencodeProcessRegistry') return {
          reapOrphanedProcesses: async () => { effects.reap += 1; return { reaped: 0 }; },
          registerManagedProcess: async () => { effects.registry += 1; },
          unregisterManagedProcess: async () => { effects.registry += 1; },
        };
        if (id === './managed-opencode-process') return load('./managed-opencode-process.ts');
        if (id === './owned-process') return load('./owned-process.ts');
        return require(id);
      },
      process: {
        env, platform: 'linux', pid: process.pid,
        kill: () => { effects.signal += 1; throw new Error('NUMERIC_SIGNAL_REACHED'); },
      },
      URL, Buffer, AbortController, setTimeout, clearTimeout, console,
    });
  };
  // This is the complete production manager export with the real start/stop/
  // restart queue. Only editor and OS effects above are fixture boundaries.
  const manager: OpenCodeManager = load('./opencode.ts').createOpenCodeManager({
    globalStorageUri: { fsPath: '/extension-storage' },
  });
  return { manager, effects, env, initialEnv };
}

const noEffects = { reap: 0, cli: 0, read: 0, cwd: 0, port: 0, spawn: 0, registry: 0, signal: 0 };

test('registered manager automatic/manual bootstrap and restart refuse before every managed effect', async () => {
  const { manager, effects, env, initialEnv } = fixture();
  const states: Array<{ status: string; error?: string }> = [];
  const subscription = manager.onStatusChange((status, error) => states.push({ status, error }));
  try {
    await manager.start(); // extension activation's real entry point
    assert.equal(manager.getStatus(), 'error');
    assert.match(states.at(-1)?.error ?? '', /OPENCODE_MANAGED_UNSUPPORTED/);
    assert.equal(manager.getApiUrl(), null);
    assert.equal(await waitForApiUrl(manager, 10), null);
    await manager.start('/other-workspace');
    await manager.restart(); // command/webview/config/upgrade restart entry point
    assert.equal(manager.getStatus(), 'error');
    assert.match(states.at(-1)?.error ?? '', /OPENCODE_MANAGED_UNSUPPORTED/);
    await manager.stop(); // extension deactivation
    assert.equal(manager.getStatus(), 'disconnected');
    assert.deepEqual(effects, noEffects);
    assert.deepEqual(env, initialEnv, 'binary/password settings cannot opt into managed lifecycle');
  } finally {
    subscription.dispose();
    await manager.stop();
  }
});

for (const url of ['https://gateway.example:8443/', 'http://127.0.0.1:4096/', 'https://gateway.example/prefix///']) {
  test(`external configured URL remains adopted and client/readiness controls work: ${url}`, async () => {
    const { manager, effects, env, initialEnv } = fixture(url);
    const normalized = url.replace(/\/+$/, '');
    await manager.start('/workspace');
    assert.equal(manager.getStatus(), 'connected');
    assert.equal(manager.getApiUrl(), normalized);
    assert.equal(await waitForApiUrl(manager, 10), normalized);
    assert.deepEqual({ ...manager.getOpenCodeAuthHeaders() }, {
      Authorization: `Basic ${Buffer.from('fixture-user:fixture-only-password').toString('base64')}`,
    });
    assert.equal(manager.getWorkingDirectory(), '/workspace');
    await manager.restart();
    assert.equal(manager.getStatus(), 'connected');
    assert.equal(await waitForApiUrl(manager, 10), normalized);
    await manager.stop();
    assert.equal(manager.getStatus(), 'disconnected');
    assert.equal(manager.getApiUrl(), normalized, 'stop disconnects the client, not the external server');
    await manager.start();
    assert.equal(manager.getStatus(), 'connected');
    assert.deepEqual(effects, noEffects);
    assert.deepEqual(env, initialEnv);
  });
}

test('actual managed and external upgrade entry points refuse without any update or numeric stop', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('UPGRADE_REQUEST_REACHED'); };
  try {
    for (const apiUrl of ['', 'https://external.example/']) {
      const { manager, effects } = fixture(apiUrl);
      await manager.start();
      const status = await getOpenCodeUpgradeStatus(manager);
      assert.equal(status.available, false);
      const result = await upgradeManagedOpenCode(manager, '1.2.3');
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'OPENCODE_UPGRADE_UNSUPPORTED');
      // Debug capability discovery may inspect CLI availability. It must never
      // launch, reap, allocate a port, or stop a process.
      assert.equal(effects.spawn + effects.reap + effects.port + effects.cwd + effects.registry + effects.signal, 0);
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
