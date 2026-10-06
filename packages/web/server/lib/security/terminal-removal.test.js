import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, test } from 'vitest';

// Isolate index.js import-time paths and singleton timers, as human-host-index
// does. Real Better Auth test helpers seed the session; no route/auth mocks.
let receipt;
beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'terminal-removal-test-'));
  fs.chmodSync(root, 0o700);
  const probePath = new URL('./terminal-removal-probe.mjs', import.meta.url);
  try {
    const child = spawn(process.execPath, [probePath.pathname], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, TMPDIR: root, NODE_ENV: 'test',
        TERMINAL_PROBE_SOURCE: new URL('../../../../../', import.meta.url).pathname },
    });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    }).finally(() => clearTimeout(deadline));
    assert.equal(status, 0, output);
    const line = output.split('\n').find(value => value.startsWith('TERMINAL_REMOVAL_RECEIPT='));
    assert.ok(line, output);
    receipt = JSON.parse(line.slice('TERMINAL_REMOVAL_RECEIPT='.length));
    assert.equal(receipt.stopped, true);
    assert.equal(receipt.externalAttempts, 0);
  } finally { fs.rmSync(root, {recursive:true,force:true}); }
}, 60_000);

for (const label of ['signed-in', 'signed-out']) {
  test(`${label}: every former terminal HTTP path is refused`, () => {
    const rows = receipt.results.filter(row => row.label === label && row.method !== 'WS');
    assert.equal(rows.length, 10);
    for (const row of rows) assert.equal(row.status, label === 'signed-in' ? 404 : 401, row.route);
  });
  test(`${label}: upgrades to every former terminal path are rejected`, () => {
    const rows = receipt.results.filter(row => row.label === label && row.method === 'WS');
    assert.equal(rows.length, 10);
    for (const row of rows) assert.notEqual(row.status, 101, row.route);
  });
}
