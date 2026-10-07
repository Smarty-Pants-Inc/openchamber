import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, test } from 'vitest';

// smarty-code#1398 slice 2. Boots the real exported server in human mode in a
// child process (index.js holds import-time paths and singletons), with a real
// Better Auth session, served-app index mode and an upstream that answers every
// forwarded request with a success sentinel. Every removed host-power route must
// be refused by OpenChamber itself: never forwarded, never the index, and its
// upgrade refused and closed by the server (a client deadline fails).
const CANONICAL = 66;
const VARIANTS = 8;
let receipt;
beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'host-power-removal-test-'));
  fs.chmodSync(root, 0o700);
  const probePath = new URL('./host-power-removal-probe.mjs', import.meta.url);
  try {
    const child = spawn(process.execPath, [probePath.pathname], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, TMPDIR: root, NODE_ENV: 'test',
        HOST_POWER_PROBE_SOURCE: new URL('../../../../../', import.meta.url).pathname },
    });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 150_000);
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    }).finally(() => clearTimeout(deadline));
    if (process.env.HOST_POWER_RECEIPT_FILE) fs.writeFileSync(process.env.HOST_POWER_RECEIPT_FILE, output);
    assert.equal(status, 0, output.slice(-4000));
    const line = output.split('\n').find(value => value.startsWith('HOST_POWER_RECEIPT='));
    assert.ok(line, output.slice(-4000));
    receipt = JSON.parse(line.slice('HOST_POWER_RECEIPT='.length));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 170_000);

test('the server survives every removed route, runs no command and makes no external request', () => {
  assert.equal(receipt.listening, true);
  assert.equal(receipt.execMarker, false);
  // No worktree was created, so the repository's post-checkout hook never ran.
  assert.equal(receipt.hookRan, false);
  assert.equal(receipt.worktrees, 1);
  assert.equal(receipt.externalAttempts, 0);
});

test('no removed route is registered, and the one retired-route refusal is the first upgrade listener', () => {
  assert.deepEqual(receipt.registeredRetired, []);
  assert.equal(receipt.firstUpgradeListener, 'refuseRetiredRouteUpgrade');
});

test('no removed request or upgrade reaches the upstream proxy target', () => {
  assert.deepEqual(receipt.upstreamRetired, []);
});

test('controls prove served-app index mode and a valid human session', () => {
  const index = receipt.results.find(row => row.label === 'control');
  assert.equal(index.indexServed, true);
  assert.equal(receipt.results.find(row => row.label === 'signed-in' && row.method === 'CONTROL')?.status, 200);
});

for (const label of ['signed-in', 'signed-out']) {
  const rows = kind => receipt.results.filter(row => row.label === label && kind(row));
  const isHttp = row => !['WS', 'PREFLIGHT', 'KEPT', 'KEPT-PREFLIGHT', 'SESSION-WORKTREE', 'CONTROL', 'CONTROL-WS', 'CONTROL-VOICE'].includes(row.method);

  test(label + ': every removed HTTP route is refused locally', () => {
    const http = rows(isHttp);
    assert.equal(http.length, CANONICAL + VARIANTS);
    for (const row of http) {
      assert.equal(row.leaked, false, row.method + ' ' + row.route + ' returned the upstream or index sentinel');
      // Canonical paths keep the authentication contract: 401 signed out, 404 signed in.
      const expected = label === 'signed-in' ? [404] : row.variant ? [401, 404] : [401];
      assert.ok(expected.includes(row.status), row.method + ' ' + row.route + ' => ' + row.status);
    }
  });

  test(label + ': the server refuses and closes an upgrade to every removed path', () => {
    const ws = rows(row => row.method === 'WS');
    assert.equal(ws.length, CANONICAL + VARIANTS);
    for (const row of ws) {
      assert.equal(row.status, 404, row.route);
      assert.equal(row.closedByServer, true, row.route);
    }
  });

  test(label + ': a packaged client preflight for a removed route is refused, never 204', () => {
    const preflights = rows(row => row.method === 'PREFLIGHT');
    assert.equal(preflights.length, CANONICAL);
    for (const row of preflights) {
      assert.equal(row.leaked, false, row.route);
      assert.equal(row.status, 404, row.requested + ' ' + row.route);
    }
  });

  test(label + ': the read-only git routes, their preflight and the remaining sockets keep working', () => {
    const kept = rows(row => row.method === 'KEPT');
    assert.equal(kept.length, 7);
    for (const row of kept) {
      assert.equal(row.leaked, false, row.route);
      if (label === 'signed-out') assert.equal(row.status, 401, row.route);
      else assert.equal(row.status, 200, row.route);
    }
    assert.equal(rows(row => row.method === 'KEPT-PREFLIGHT')[0]?.status, 204);
    // A session create carrying a worktree is refused (401 signed out, 400 signed in), never run.
    const sessionWorktree = rows(row => row.method === 'SESSION-WORKTREE')[0];
    assert.equal(sessionWorktree?.status, label === 'signed-in' ? 400 : 401, sessionWorktree?.body);
    assert.equal(rows(row => row.method === 'CONTROL-WS')[0]?.status, label === 'signed-in' ? 101 : 401);
    // The voice owner still answers its own socket (parameter validation first, as before), not the refusal.
    const voice = rows(row => row.method === 'CONTROL-VOICE')[0];
    assert.equal(voice?.status, 400);
  });
}
