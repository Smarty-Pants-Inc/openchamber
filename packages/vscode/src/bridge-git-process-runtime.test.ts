import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { execGit, stopGitProcesses } from './bridge-git-process-runtime';

const require = createRequire(import.meta.url);
const unavailable = /GIT_PROCESS_UNSUPPORTED.*unavailable/i;

// Execute complete production receivers and the process owner. Only editor and
// native effects are controlled, as in managed-opencode-process.test.ts.
function fixture(platform = 'linux') {
  const effects = { env: 0, home: 0, fs: 0, exec: 0, spawn: 0, signal: 0, timer: 0 };
  let ownedPulls = 0;
  const nativeProcess = {
    platform,
    get env() { effects.env += 1; return { SSH_AUTH_SOCK: '', PATH: '/fixture' }; },
    kill: () => { effects.signal += 1; throw new Error('NUMERIC_SIGNAL_REACHED'); },
  };
  const nativeChildProcess = {
    execFile: () => { effects.exec += 1; throw new Error('AUTH_EXEC_REACHED'); },
    spawn: () => { effects.spawn += 1; throw new Error('CHILD_SPAWN_REACHED'); },
  };
  const nativeFs = {
    promises: {
      stat: async () => { effects.fs += 1; throw new Error('SOCKET_STAT_REACHED'); },
      rm: async () => { effects.fs += 1; throw new Error('FILE_REMOVAL_REACHED'); },
    },
  };
  const repository = { pull: async () => { ownedPulls += 1; } };
  const editor = {
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    extensions: {
      getExtension: () => ({
        isActive: true,
        exports: {
          enabled: true,
          getAPI: () => ({ git: { path: '/fixture/custom-git' }, getRepository: () => repository }),
          onDidChangeEnablement: () => {},
        },
      }),
    },
  };
  const evaluate = (file: string, dependencies: (id: string) => ReturnType<typeof require>) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    return runInNewContext(`${code}\nmodule.exports;`, {
      module, exports: module.exports, require: dependencies,
      process: nativeProcess, Error, Buffer, console,
      setTimeout: () => { effects.timer += 1; throw new Error('TIMER_REACHED'); },
      clearTimeout: () => {},
    });
  };
  const native = (id: string) => {
    if (id === 'child_process' || id === 'node:child_process') return nativeChildProcess;
    if (id === 'fs') return nativeFs;
    if (id === 'os') return { homedir: () => { effects.home += 1; return '/fixture'; } };
    if (id === 'vscode') return editor;
    return require(id);
  };
  const owned = evaluate('./owned-process.ts', native);
  const runtime: typeof import('./bridge-git-process-runtime') = evaluate('./bridge-git-process-runtime.ts', (id) => (
    id === './owned-process' ? owned : native(id)
  ));
  const pathDiff = evaluate('./gitPathDiff.ts', native);
  const brand = evaluate('./brand.generated.ts', native);
  const service: typeof import('./gitService') = evaluate('./gitService.ts', (id) => {
    if (id === './bridge-git-process-runtime') return runtime;
    if (id === './gitPathDiff') return pathDiff;
    if (id === './brand.generated') return brand;
    return native(id);
  });
  const receiver: typeof import('./bridge-git-runtime') = evaluate('./bridge-git-runtime.ts', (id) => (
    id === './gitService' ? service : native(id)
  ));
  return { runtime, receiver, effects, ownedPulls: () => ownedPulls };
}

const noEffects = { env: 0, home: 0, fs: 0, exec: 0, spawn: 0, signal: 0, timer: 0 };
const requests = [
  { name: 'no timeout', args: ['status'], options: {} },
  { name: 'timeout', args: ['check-ignore', '--', 'file'], options: { timeoutMs: 1 } },
  { name: 'custom binary', args: ['status'], options: { binary: '/fixture/custom-git' } },
  ...['inherit', 'ignore'].map((stdio) => ({
    name: `hook descendant with ${stdio === 'inherit' ? 'inherited' : 'redirected'} pipes`,
    args: ['-c', `alias.oc-hook=!node -e 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"${stdio}"})'`, 'oc-hook'],
    options: { timeoutMs: 1 },
  })),
];

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`actual raw executor refuses every request before native effects on ${platform}`, async () => {
    const { runtime, effects } = fixture(platform);
    for (const request of requests) {
      await assert.rejects(runtime.execGit(request.args, '/fixture/workspace', request.options), unavailable, request.name);
      assert.deepEqual(effects, noEffects, request.name);
    }
    await Promise.all([runtime.stopGitProcesses(), runtime.stopGitProcesses()]);
    await assert.rejects(runtime.execGit(['status'], '/fixture/workspace'), unavailable);
    assert.deepEqual(effects, noEffects);
  });
}

test('actual Git bridge receivers reject raw reads, writes and rebase pulls without fallback effects', async () => {
  const { receiver, effects, ownedPulls } = fixture();
  for (const message of [
    { type: 'api:git/check', payload: { directory: '/fixture/workspace' } },
    { type: 'api:git/stage', payload: { directory: '/fixture/workspace', path: 'file' } },
    { type: 'api:git/revert', payload: { directory: '/fixture/workspace', path: 'file' } },
    { type: 'api:git/pull', payload: { directory: '/fixture/workspace', rebase: true } },
  ]) {
    await assert.rejects(receiver.handleStandardGitBridgeMessage({ id: 'fixture', ...message }), unavailable);
  }
  assert.deepEqual(effects, noEffects);
  assert.equal(ownedPulls(), 0);
});

test('supported VS Code-owned pull still reaches the actual receiver and service', async () => {
  const { receiver, effects, ownedPulls } = fixture();
  const response = await receiver.handleStandardGitBridgeMessage({
    id: 'fixture', type: 'api:git/pull', payload: { directory: '/fixture/workspace' },
  });
  assert.equal(response?.success, true);
  assert.equal(ownedPulls(), 1);
  assert.deepEqual(effects, noEffects);
});

test('direct production import rejects without inspecting command options, and stop is harmless', async () => {
  let optionReads = 0;
  const options = {
    get binary(): string { optionReads += 1; throw new Error('BINARY_OPTION_REACHED'); },
    get timeoutMs(): number { optionReads += 1; throw new Error('TIMEOUT_OPTION_REACHED'); },
  };
  await assert.rejects(execGit(['status'], '/fixture/workspace', options), unavailable);
  await Promise.all([stopGitProcesses(), stopGitProcesses()]);
  await assert.rejects(execGit(['status'], '/fixture/workspace'), unavailable);
  assert.equal(optionReads, 0);
});
