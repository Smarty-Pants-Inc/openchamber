import { describe, expect, it, vi } from 'vitest';
import { printJson } from './cli-output.js';

async function withInteractiveTty(fn) {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

  try {
    return await fn();
  } finally {
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    } else {
      delete process.stdout.isTTY;
    }

    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    } else {
      delete process.stdin.isTTY;
    }
  }
}

describe('cli output', () => {
  it('creates interactive clack spinner and progress helpers', async () => {
    await withInteractiveTty(async () => {
      const output = await import('./cli-output.js?interactive-test');

      expect(output.createSpinner({})).toBeTruthy();
      await expect(output.createProgress({}, { max: 2 })).resolves.toBeTruthy();
    });
  });

  it('preserves opaque JSON messages byte-for-byte', () => {
    const message = 'OpenCode failed at /tmp/OpenChamber/config via https://provider.example/OpenCode';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      printJson({ messages: [{ level: 'error', message }] });
      const payload = JSON.parse(write.mock.calls.map(([chunk]) => String(chunk)).join(''));
      expect(payload.messages[0].message).toBe(message);
    } finally {
      write.mockRestore();
    }
  });
});
