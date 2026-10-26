// Smarty Code (openchamber#649 review P1-2): untracked files the working-tree walkthrough leaves out (past the
// listing cap, or over the diff size cap) are reported in the read's result, never silently dropped (digest.js).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-untracked-omitted-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const LISTED = Array.from({ length: 205 }, (_, i) => `scratch/n${String(i).padStart(3, '0')}.txt`);
vi.mock('../git/service.js', () => ({
  getRepositoryRoot: vi.fn(async () => '/repo'),
  getDiff: vi.fn(async () => ''),
  getRangeDiff: vi.fn(async () => ''),
  listUntrackedPaths: vi.fn(async () => LISTED),
  // The first file is over the size cap; every other one is a one-line new file.
  getUntrackedDiffs: vi.fn(async (_directory, paths, { onSkip } = {}) => paths.map((file, index) => {
    if (index === 0) { onSkip?.(file, 'too-large'); return ''; }
    return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+line\n`;
  })),
}));
vi.mock('../small-model/index.js', () => ({ describeSmallModel: vi.fn(async () => { throw new Error('no model'); }), generateSmallModelText: vi.fn() }));
const { getWalkthrough } = await import('./index.js');
const { loadSourceSections } = await import('./sources.js');
const { getUntrackedDiffs } = await import('../git/service.js');

afterAll(() => fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true }));

describe('working-tree walkthrough with untracked files left out', () => {
  it('reads only the first 200, and its meta names the too-large one and those past the cap', async () => {
    const { sections, meta } = await loadSourceSections('/repo', { kind: 'working-tree', scope: 'working' });
    expect(getUntrackedDiffs.mock.calls.at(-1)[1]).toHaveLength(200);
    expect(sections[0].patch).toContain('scratch/n199.txt');
    expect(sections[0].patch).not.toContain('scratch/n200.txt');
    expect(meta.untrackedOmitted).toEqual({
      count: 6, limit: 200,
      paths: [{ path: 'scratch/n000.txt', reason: 'too-large' },
        ...['n200', 'n201', 'n202', 'n203', 'n204'].map((name) => ({ path: `scratch/${name}.txt`, reason: 'cap' }))],
    });
  });

  it('the walkthrough read carries it to the client', async () => {
    const result = await getWalkthrough({ directory: '/repo', source: { kind: 'working-tree', scope: 'working' } });
    expect(result.untrackedOmitted).toMatchObject({ count: 6, limit: 200 });
    expect(result.hunkCount).toBe(199);
  });

  it('nothing left out: no untrackedOmitted', async () => {
    const { meta } = await loadSourceSections('/repo', { kind: 'working-tree', scope: 'staged' });
    expect(meta).toEqual({});
  });
});
