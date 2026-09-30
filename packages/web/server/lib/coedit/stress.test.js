// smartyfs#32's acceptance, kept in CI at a short duration: stress.mjs exits 1 if any revision is lost.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { ensureHelper } from './fs-helper/ensure-built.js';

const built = ensureHelper();
const stress = path.join(import.meta.dirname, 'stress.mjs');
/**
 * A keeper leads its own process group and runs the stress run in it (argv: stress.mjs and its arguments); nothing in
 * the tree leaves the group. On 'k' it SIGKILLs the run through its own handle (smartyfs#37 item 17). When its stdin
 * pipe closes (the test runner died before its cleanup) it SIGKILLs its whole group, itself included: it is the
 * group's leader and still alive, so the group id is still its own (item 18).
 */
const KEEPER = `
  const run = require('child_process').spawn(process.execPath, process.argv.slice(1), { stdio: 'ignore' });
  process.stdin.on('data', () => run.kill('SIGKILL'));
  process.stdin.on('end', () => process.kill(-process.pid, 'SIGKILL'));`;
/** Starts a keeper for a stress run in `own`, with a stdin pipe from this process. */
const keep = (own, seconds) => spawn(process.execPath, ['-e', KEEPER, stress, '--seconds', String(seconds), '--seed', '37', '--dir', own],
  { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
/** Live, non-zombie processes whose command line names `own`, except `but`. */
const inside = (own, but) => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p) && Number(p) !== but).filter((p) => {
  try {
    return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(own) && !fs.readFileSync(`/proc/${p}/stat`, 'utf8').includes(') Z ');
  } catch {
    return false;
  }
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-stress-ci-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!built)('co-edit stress (smartyfs#32 acceptance)', () => {
  it('concurrent direct writers, saves, and helper and bridge kills for 20 s lose no revision', () => {
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'stress.mjs'), '--seconds', '20', '--seed', '32', '--dir', dir], { encoding: 'utf8', timeout: 90_000 });
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    expect(report).toMatchObject({ lostWrites: 0, lostSaves: 0 });
    expect(report.writes).toBeGreaterThan(100);
    expect(report.kills.server + report.kills.helper).toBeGreaterThan(3);
    expect(run.status).toBe(0);
  }, 120_000);

  it('a SIGKILLed stress run leaves no writer, server or helper behind (smartyfs#37 item 4)', async () => {
    const own = fs.mkdtempSync(path.join(dir, 'kill-'));
    // The keeper stays this process's unreaped child until the cleanup below, so the group id (its pid) cannot be reused
    // before the group is signalled.
    const keeper = keep(own, 60);
    const mine = () => inside(own, keeper.pid);
    try {
      await expect.poll(() => mine().length, { timeout: 10_000 }).toBeGreaterThan(4); // The run, writers, server, helper.
      keeper.stdin.write('k');
      await expect.poll(() => mine(), { timeout: 5000 }).toEqual([]);
    } finally {
      // Synchronous: this process reaps the keeper only in its event loop, so between the check and the signal the pid
      // (alive or a zombie) still holds the group id. Only this test's own group is signalled.
      if (keeper.exitCode === null && keeper.signalCode === null) process.kill(-keeper.pid, 'SIGKILL');
    }
  }, 30_000);

  it('a test runner that dies before its cleanup leaves no stress run behind (smartyfs#37 item 18)', async () => {
    const own = fs.mkdtempSync(path.join(dir, 'runner-'));
    // A stand-in for the test runner: it starts a keeper exactly as a test does, then is SIGKILLed through its handle.
    const runner = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'child_process';
      const keeper = spawn(process.execPath, ['-e', ${JSON.stringify(KEEPER)}, ${JSON.stringify(stress)}, '--seconds', '20', '--seed', '37', '--dir', ${JSON.stringify(own)}],
        { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
      setInterval(() => {}, 1000);`], { stdio: 'ignore' });
    const guard = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', own], { stdio: 'ignore' }); // Outside the group.
    try {
      await expect.poll(() => inside(own, guard.pid).length, { timeout: 10_000 }).toBeGreaterThan(4); // Keeper, run, writers, server, helper.
      runner.kill('SIGKILL');
      // Nothing signals the run here: on a failure, it ends on its own within its 20 s.
      await expect.poll(() => inside(own, guard.pid), { timeout: 5000 }).toEqual([]);
      expect(guard.exitCode === null && guard.signalCode === null).toBe(true);
    } finally {
      guard.kill('SIGKILL');
      runner.kill('SIGKILL');
    }
  }, 30_000);
});
