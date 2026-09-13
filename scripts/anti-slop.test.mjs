import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./anti-slop.mjs', import.meta.url));
const diagnostic = {
  filename: 'src/a.ts', code: 'anti-slop(no-runtime-typeof)', severity: 'error',
  message: 'A finding retained for independent disposition.',
  labels: [{ span: { line: 2, column: 3 }, message: 'Original label detail' }],
  help: 'Original help must remain in the raw report.',
};

function runReport({ output = '{"diagnostics":[]}', status = 0, signal = false,
  paths = ['src/a.ts'], missingTool = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'oc-anti-slop-report-'));
  try {
    writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ output, status, signal }));
    // Real Bun dispatches an isolated package script, not Oxlint or a mocked module.
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { 'lint:anti-slop': 'node fixture.cjs' } }));
    writeFileSync(join(directory, 'fixture.cjs'), `
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync('fixture.json', 'utf8'));
fs.writeFileSync('arguments.json', JSON.stringify(process.argv.slice(2)));
process.stdout.write(fixture.output);
if (fixture.signal) process.kill(process.pid, 'SIGTERM');
else process.exit(fixture.status);
`);
    const child = spawnSync(process.execPath, [script, 'file', '--include-noisy', '--', ...paths], {
      cwd: directory, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { PATH: missingTool ? directory : process.env.PATH, HOME: directory, CI: 'true' },
    });
    assert.equal(child.error, undefined);
    const argumentsFile = join(directory, 'arguments.json');
    return { ...child, arguments: existsSync(argumentsFile) ? JSON.parse(readFileSync(argumentsFile, 'utf8')) : null,
      claimsCreated: existsSync(join(directory, '.openchamber')) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('explicit full-scope report retains findings, noisy rules, raw detail and exact path arguments', () => {
  const paths = ['src/a.ts', 'src/space name.ts', 'src/tab\tname.ts', 'src/new\nline.ts', "src/quote';$(never).ts", '--odd.ts'];
  const output = JSON.stringify({ diagnostics: [diagnostic], number_of_files: paths.length });
  const result = runReport({ output, status: 1, paths });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.arguments, ['--format', 'json', '--', ...paths]);
  assert.ok(result.stdout.includes(output));
  assert.ok(result.stdout.includes('Raw Oxlint exit code: 1'));
  assert.ok(result.stdout.includes('Noisy rules included: yes'));
  assert.ok(result.stdout.includes('1 findings'));
  assert.ok(result.stdout.includes('no-runtime-typeof'));
  assert.ok(result.stdout.includes('Report completion is not lint-clean or authored-finding acceptance.'));
  assert.equal(result.claimsCreated, false);
});

test('valid clean and warning-only reports retain the actual zero exit', () => {
  for (const diagnostics of [[], [{ ...diagnostic, severity: 'warning' }]]) {
    const result = runReport({ output: JSON.stringify({ diagnostics }) });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Raw Oxlint exit code: 0'));
    assert.ok(result.stdout.includes(`${diagnostics.length} findings`));
  }
});

test('missing, malformed, incomplete and contradictory reports fail closed', () => {
  for (const fixture of [
    { output: '' }, { output: 'not JSON' }, { output: '{}' }, { output: '{"diagnostics":null}' },
    { output: '{"diagnostics":[]}', status: 1 },
    { output: JSON.stringify({ diagnostics: [diagnostic] }), status: 0 },
    { output: JSON.stringify({ diagnostics: [{ ...diagnostic, labels: [] }] }), status: 1 },
    { output: JSON.stringify({ diagnostics: [{ ...diagnostic, message: 4 }] }), status: 1 },
  ]) {
    const result = runReport(fixture);
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('Report completion is not lint-clean'));
  }
});

test('spawn failures, abnormal exits and signals remain failures with a valid findings report', () => {
  for (const fixture of [{ missingTool: true }, { status: 2 }, { status: 7 }, { signal: true }]) {
    const result = runReport({ output: JSON.stringify({ diagnostics: [diagnostic] }), ...fixture });
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('Report completion is not lint-clean'));
  }
});

test('an empty explicit scope fails before invoking Oxlint', () => {
  const result = runReport({ paths: [] });
  assert.equal(result.status, 1);
  assert.equal(result.arguments, null);
});
