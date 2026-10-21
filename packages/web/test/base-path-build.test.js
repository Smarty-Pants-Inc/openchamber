import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

test('web build prefixes emitted HTML assets from SMARTY_CODE_BASE_PATH', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'openchamber-base-path-build-'));
  try {
    execFileSync('bun', ['run', 'build', '--outDir', outDir], {
      cwd: webRoot,
      env: { ...process.env, SMARTY_CODE_BASE_PATH: '/code' },
      stdio: 'pipe',
    });
    const html = readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => /(?:^|\/)assets\/[^?#]+\.(?:js|css)(?:[?#]|$)/.test(url));
    assert.ok(assets.length > 0, 'build emits JavaScript or CSS asset URLs');
    assert.ok(assets.every((url) => url.startsWith('/code/')), 'asset URLs: ' + assets.join(', '));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 180_000);
