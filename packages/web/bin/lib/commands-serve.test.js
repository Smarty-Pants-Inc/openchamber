import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: spawnMock };
});

const { createServeCommand } = await import('./commands-serve.js');

const FAKE_SERVER_PATH = path.join(os.tmpdir(), 'openchamber-serve-test-server.js');

function createDeps(overrides = {}) {
  return {
    serverPath: FAKE_SERVER_PATH,
    bunBin: '/fake/bun',
    checkOpenCodeCLI: vi.fn(async () => null),
    getPreferredServerRuntime: vi.fn(() => 'node'),
    setForegroundServerActive: vi.fn(),
    setForegroundShutdown: vi.fn(),
    ...overrides,
  };
}

function withRuntimeEnv(value, fn) {
  const previous = process.env.OPENCHAMBER_RUNTIME;
  if (typeof value === 'string') {
    process.env.OPENCHAMBER_RUNTIME = value;
  } else {
    delete process.env.OPENCHAMBER_RUNTIME;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_RUNTIME = previous;
      } else {
        delete process.env.OPENCHAMBER_RUNTIME;
      }
    });
}

function stubDaemonChild({ port = 45678 } = {}) {
  const child = new EventEmitter();
  child.pid = process.pid;
  child.unref = vi.fn();
  child.disconnect = vi.fn();
  child.connected = true;
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => {
      child.emit('message', { type: 'openchamber:ready', port });
    });
    return child;
  });
  return child;
}

describe('serve command runtime identity', () => {
  beforeEach(() => {
    fs.writeFileSync(FAKE_SERVER_PATH, '// fake server module for import probing\n');
  });

  afterEach(() => {
    fs.rmSync(FAKE_SERVER_PATH, { force: true });
    spawnMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('defaults to the web runtime when OPENCHAMBER_RUNTIME is unset (foreground)', async () => {
    await withRuntimeEnv(undefined, async () => {
      const serveCommand = createServeCommand(createDeps());
      // The fake server module has no startWebUiServer export, so the
      // foreground launch fails right after the env is propagated — exactly
      // the point where the runtime identity becomes observable.
      await expect(serveCommand({ port: 0, foreground: true, quiet: true, suppressQuietOutput: true }))
        .rejects.toThrow(/startWebUiServer is not a function/);
      expect(process.env.OPENCHAMBER_RUNTIME).toBe('web');
    });
  });

  it('honors an explicit OPENCHAMBER_RUNTIME override in foreground mode', async () => {
    await withRuntimeEnv('smarty-oc', async () => {
      const serveCommand = createServeCommand(createDeps());
      await expect(serveCommand({ port: 0, foreground: true, quiet: true, suppressQuietOutput: true }))
        .rejects.toThrow(/startWebUiServer is not a function/);
      expect(process.env.OPENCHAMBER_RUNTIME).toBe('smarty-oc');
    });
  });

  it('spawns the daemon child with the web runtime by default', async () => {
    await withRuntimeEnv(undefined, async () => {
      stubDaemonChild();
      const serveCommand = createServeCommand(createDeps());
      const port = await serveCommand({ port: 0, quiet: true, suppressQuietOutput: true });

      expect(port).toBe(45678);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, , spawnOptions] = spawnMock.mock.calls[0];
      expect(spawnOptions.env.OPENCHAMBER_RUNTIME).toBe('web');
    });
  });

  it('spawns the daemon child with an explicit OPENCHAMBER_RUNTIME override', async () => {
    await withRuntimeEnv('smarty-oc', async () => {
      stubDaemonChild();
      const serveCommand = createServeCommand(createDeps());
      const port = await serveCommand({ port: 0, quiet: true, suppressQuietOutput: true });

      expect(port).toBe(45678);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, , spawnOptions] = spawnMock.mock.calls[0];
      expect(spawnOptions.env.OPENCHAMBER_RUNTIME).toBe('smarty-oc');
    });
  });
});
