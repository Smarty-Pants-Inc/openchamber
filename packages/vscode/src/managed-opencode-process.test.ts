import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the complete production modules. Only the OS process/registry boundary
// is controlled; no child or numeric process group is created by these fixtures.
const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// The fixture owns the OS transitions of fields readonly to process callers.
type FixtureExitState = { -readonly [Key in 'exitCode' | 'signalCode']: ChildProcess[Key] };

function fixture({ exitedOnTerm = false, closedOnTerm = true, rejectSpawn = false } = {}) {
  const state: FixtureExitState = { exitCode: null, signalCode: null };
  const child = Object.assign(new EventEmitter(), state, {
    pid: 45678,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let spawnCount = 0;
  let registryCount = 0;
  const exit = (close: boolean) => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    if (close) child.emit('close', 0, null);
  };
  const ownedModule = { exports: {} };
  const owned = runInNewContext(`${compile('./owned-process.ts')}\nmodule.exports;`, {
    module: ownedModule, exports: ownedModule.exports,
    require: (id: string) => {
      assert.equal(id, 'node:child_process');
      return {
        spawn: () => {
          spawnCount += 1;
          if (rejectSpawn) throw new Error('CHILD_SPAWN_REACHED');
          return child;
        },
        execFile: () => { throw new Error('Unexpected Windows tree termination'); },
      };
    },
    process: {
      platform: 'linux',
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM' && exitedOnTerm) exit(closedOnTerm);
        if (signal === 'SIGKILL') exit(true);
      },
    },
    // Advance the grace deadline without a wall-clock wait. Production still
    // follows its actual waitForClose/termination ordering.
    setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1; },
    clearTimeout: () => {},
  });
  const managedModule = { exports: {} };
  const managed = runInNewContext(`${compile('./managed-opencode-process.ts')}\nmodule.exports;`, {
    module: managedModule, exports: managedModule.exports,
    require: (id: string) => {
      if (id === './owned-process') return owned;
      assert.equal(id, './opencodeProcessRegistry');
      return {
        registerManagedProcess: async () => { registryCount += 1; },
        unregisterManagedProcess: async () => { registryCount += 1; },
      };
    },
    process: { pid: process.pid }, Buffer, setTimeout, clearTimeout,
  });
  return { child, owned, managed, signals, exit, counts: () => ({ spawnCount, registryCount }) };
}

for (const aborted of [false, true]) {
  test(`actual managed launcher is unsupported before spawn/registration, aborted=${aborted}`, () => {
    const runtime = fixture({ rejectSpawn: true });
    const controller = new AbortController();
    if (aborted) controller.abort();
    assert.throws(() => runtime.managed.spawnManagedOpenCodeProcess('opencode', ['serve'], {
      cwd: '/unused', env: { OPENCODE_BINARY: '/explicit/override' }, port: 45678,
      timeoutMs: 1000, signal: controller.signal, sourceBinary: 'opencode', appBundleHint: '',
    }), /OPENCODE_MANAGED_UNSUPPORTED/);
    assert.deepEqual(runtime.counts(), { spawnCount: 0, registryCount: 0 });
    assert.deepEqual(runtime.signals, []);
  });
}

for (const close of [false, true]) {
  test(`retained owned handle cannot signal a recycled group after root exit, close=${close}`, async () => {
    const runtime = fixture();
    const handle = runtime.owned.spawnOwnedProcess('fixture', [], { cwd: '/unused', env: {} });
    runtime.exit(close);
    if (!close) runtime.child.emit('close', 0, null);
    await handle.closed;
    await Promise.all([handle.terminate(), handle.terminate()]);
    assert.deepEqual(runtime.signals, [], 'no TERM or KILL to the retired numeric target');
  });
}

test('root exit while pipes remain open refuses numeric teardown and reports incomplete cleanup', async () => {
  const runtime = fixture();
  const handle = runtime.owned.spawnOwnedProcess('fixture', [], { cwd: '/unused', env: {} });
  runtime.exit(false);
  await assert.rejects(handle.terminate(), /did not close/);
  assert.deepEqual(runtime.signals, []);
  runtime.child.emit('close', 0, null);
  await handle.closed;
});

test('TERM-caused root closure fences the delayed KILL', async () => {
  const runtime = fixture({ exitedOnTerm: true });
  const handle = runtime.owned.spawnOwnedProcess('fixture', [], { cwd: '/unused', env: {} });
  await handle.terminate();
  assert.deepEqual(runtime.signals, [{ pid: -45678, signal: 'SIGTERM' }]);
});

test('a close-only completion retires custody even without exit fields', async () => {
  const runtime = fixture();
  const handle = runtime.owned.spawnOwnedProcess('fixture', [], { cwd: '/unused', env: {} });
  runtime.child.emit('close', 0, null);
  await handle.closed;
  await handle.terminate();
  assert.deepEqual(runtime.signals, []);
});

test('TERM-caused root exit with open pipes refuses delayed KILL and reports incomplete cleanup', async () => {
  const runtime = fixture({ exitedOnTerm: true, closedOnTerm: false });
  const handle = runtime.owned.spawnOwnedProcess('fixture', [], { cwd: '/unused', env: {} });
  await assert.rejects(handle.terminate(), /did not close/);
  assert.deepEqual(runtime.signals, [{ pid: -45678, signal: 'SIGTERM' }]);
  runtime.child.emit('close', 0, null);
  await handle.closed;
});

test('live owned command still gets TERM then KILL if it holds custody through the grace deadline', async () => {
  const runtime = fixture();
  const handle = runtime.owned.spawnOwnedProcess('fixture', [], { cwd: '/unused', env: {} });
  await handle.terminate();
  assert.deepEqual(runtime.signals, [
    { pid: -45678, signal: 'SIGTERM' }, { pid: -45678, signal: 'SIGKILL' },
  ]);
});
