// smartyfs#32's acceptance, kept in CI at a short duration: stress.mjs exits 1 if any revision is lost.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { ensureHelper } from './fs-helper/ensure-built.js';

const built = ensureHelper();
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
    const run = spawn(process.execPath, [path.join(import.meta.dirname, 'stress.mjs'), '--seconds', '60', '--seed', '37', '--dir', own], { stdio: 'ignore' });
    const mine = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p) && Number(p) !== run.pid).filter((p) => {
      try {
        return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(own) && !fs.readFileSync(`/proc/${p}/stat`, 'utf8').includes(') Z ');
      } catch {
        return false;
      }
    });
    try {
      await expect.poll(() => mine().length, { timeout: 10_000 }).toBeGreaterThan(3); // Writers, server, helper.
      run.kill('SIGKILL');
      await expect.poll(() => mine(), { timeout: 5000 }).toEqual([]);
    } finally {
      // A failure above leaves nothing behind: only this test's own run and its children, by pid (smartyfs#37 item 14).
      for (const pid of [run.pid, ...mine().map(Number)]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  }, 30_000);
});
