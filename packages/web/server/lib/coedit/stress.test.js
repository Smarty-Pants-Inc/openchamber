// smartyfs#32's acceptance, kept in CI at a short duration: stress.mjs exits 1 if any revision is lost.
import { spawnSync } from 'child_process';
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
});
