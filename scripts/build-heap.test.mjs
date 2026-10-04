import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const document = parseDocument(readFileSync(path.join(root, '.github/workflows/oc-review.yml'), 'utf8'));
assert.deepEqual(document.errors, []);
const workflow = document.toJS();
const checks = workflow.jobs.checks;
const builds = checks.steps.filter((step) => step.name === 'Build');
assert.equal(builds.length, 1);
const build = builds[0];
const policy = '--max-old-space-size=4096';

const assertBuildPolicy = () => {
  assert.equal(build.run, 'bun run build');
  assert.deepEqual(build.env, { NODE_OPTIONS: policy });
};

test('the actual workflow gives only its existing Build invocation the Code heap policy', () => {
  assertBuildPolicy();
});

test('workflow, jobs and other steps do not inherit the Build heap option', () => {
  assert.equal(workflow.env?.NODE_OPTIONS, undefined);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.env?.NODE_OPTIONS, undefined, `${name} job environment`);
    for (const step of job.steps) {
      if (step === build) continue;
      assert.equal(step.env?.NODE_OPTIONS, undefined, `${name}: ${step.name}`);
    }
  }
  // Keep explicit coverage of the previously skipped later phases.
  for (const name of ['Type check', 'Tests', 'Build isolated actual-component UI proof']) {
    const steps = checks.steps.filter((step) => step.name === name);
    assert.equal(steps.length, 1, name);
    assert.equal(steps[0].env, undefined, name);
  }
  for (const name of ['Install proof Chromium', 'Prove account components with synthetic HTTP']) {
    const steps = checks.steps.filter((step) => step.name === name);
    assert.equal(steps.length, 1, name);
    assert.deepEqual(steps[0].env, {
      PLAYWRIGHT_BROWSERS_PATH: '${{ runner.temp }}/oc-auth-ui-browsers',
    }, name);
  }
});

const probeViteHeap = (heapOption, t) => {
  const marker = 'OC_VITE_HEAP ';
  const prelude = `
    import { getHeapStatistics } from 'node:v8';
    console.log(${JSON.stringify(marker)} + JSON.stringify({
      runtime: process.release.name,
      node: process.version,
      executable: process.execPath,
      argv: process.argv.slice(1),
      heapMiB: getHeapStatistics().heap_size_limit / 1024 / 1024,
    }));
  `;
  const diagnosticImport = `data:text/javascript;base64,${Buffer.from(prelude).toString('base64')}`;
  // Exercise real nested Bun dispatch and Vite's Node shebang. --help avoids
  // extension preparation, config loading and bundle outputs, not the CLI.
  const result = spawnSync(build.run.split(' ')[0], [
    'exec', 'bun run --cwd packages/web vite build --help',
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_DISABLE_COMPILE_CACHE: '1',
      NODE_OPTIONS: `${heapOption} --import=${diagnosticImport}`,
    },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Usage:/);
  const receipts = result.stdout.split('\n').filter((line) => line.startsWith(marker));
  assert.equal(receipts.length, 1, result.stdout);
  const receipt = JSON.parse(receipts[0].slice(marker.length));
  assert.equal(receipt.runtime, 'node');
  assert.equal(realpathSync(receipt.executable), realpathSync(process.execPath));
  assert.equal(realpathSync(receipt.argv[0]), realpathSync(path.join(root, 'packages/web/node_modules/.bin/vite')));
  assert.deepEqual(receipt.argv.slice(1), ['build', '--help']);
  assert.ok(Number.isFinite(receipt.heapMiB));
  t.diagnostic(`${heapOption}: ${JSON.stringify(receipt)}`);
  return receipt.heapMiB;
};

test('parsed Build policy reaches the installed Vite Node heap through nested Bun, with a 512 MiB control', (t) => {
  assertBuildPolicy();
  const parentOptions = process.env.NODE_OPTIONS;
  const buildHeap = probeViteHeap(build.env.NODE_OPTIONS, t);
  const smallHeap = probeViteHeap('--max-old-space-size=512', t);
  // V8's total heap includes more than old space, so it is not exactly 4096.
  assert.ok(buildHeap >= 4096, `Build heap limit: ${buildHeap} MiB`);
  assert.ok(smallHeap >= 512 && smallHeap < 1024, `Control heap limit: ${smallHeap} MiB`);
  assert.ok(smallHeap < buildHeap);
  assert.equal(process.env.NODE_OPTIONS, parentOptions);
});
