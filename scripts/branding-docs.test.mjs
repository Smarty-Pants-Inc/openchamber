import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(path.join(root, 'branding/brand.json'), 'utf8');
const url = 'https://github.com/Smarty-Pants-Inc/smarty-code';
const checkDocs = (files) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'smarty-docs-links-'));
  try {
    mkdirSync(path.join(fixture, 'branding'));
    mkdirSync(path.join(fixture, 'docs'));
    writeFileSync(path.join(fixture, 'branding/brand.json'), config);
    for (const [file, input] of files) writeFileSync(path.join(fixture, 'docs', file), input);
    for (const extra of [[], ['--check'], []]) {
      const result = spawnSync(process.execPath, [
        path.join(root, 'scripts/apply-brand.mjs'), '--root', fixture, '--docs', 'docs', ...extra,
      ], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      for (const [file, , expected] of files) {
        assert.equal(readFileSync(path.join(fixture, 'docs', file), 'utf8'), expected, file);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
};

test('committed aliases brand Markdown display text without changing link identities', () => {
  const cases = [
    [`[OpenChamber integration](${url})`, `[Smarty Code integration](${url})`],
    [`[OpenChamber \`tool\`](${url} "OpenChamber")`, `[Smarty Code \`tool\`](${url} "Smarty Code")`],
    ['[OpenChamber](/OpenChamber/(smarty-code)/OpenCode#OpenChamber)', '[Smarty Code](/OpenChamber/(smarty-code)/OpenCode#OpenChamber)'],
    ['![OpenChamber](../OpenChamber/smarty-code.png "OpenChamber")', '![Smarty Code](../OpenChamber/smarty-code.png "Smarty Code")'],
    ['[OpenChamber](<../OpenChamber/a b.svg>)', '[Smarty Code](<../OpenChamber/a b.svg>)'],
    ['[OpenChamber](#OpenChamber)', '[Smarty Code](#OpenChamber)'],
    ['[OpenChamber] is not a defined link', '[Smarty Code] is not a defined link'],
    ['[OpenChamber](openchamber://OpenChamber/smarty-code)', '[Smarty Code](openchamber://OpenChamber/smarty-code)'],
    ['[OpenChamber][OpenChamber]\n\n[OpenChamber]: /smarty-code "OpenChamber"', '[Smarty Code][OpenChamber]\n\n[OpenChamber]: /smarty-code "Smarty Code"'],
    ['[OpenChamber][]\n\n[OpenChamber]: /smarty-code', '[Smarty Code][OpenChamber]\n\n[OpenChamber]: /smarty-code'],
    ['[OpenChamber]\n\n[OpenChamber]: /smarty-code', '[Smarty Code][OpenChamber]\n\n[OpenChamber]: /smarty-code'],
    [`OpenChamber: ${url}?product=OpenChamber#smarty-code`, `Smarty Code: ${url}?product=OpenChamber#smarty-code`],
    [`OpenChamber <${url}>`, `Smarty Code <${url}>`],
    ['OpenChamber `OpenChamber`\n\n    OpenChamber', 'Smarty Code `OpenChamber`\n\n    OpenChamber'],
    ['```md\n[OpenChamber](/smarty-code)\n```', '```md\n[Smarty Code](/smarty-code)\n```'],
  ];
  checkDocs(cases.map(([input, expected], index) => [`case-${index}.mdx`, `${input}\n`, `${expected}\n`]));
});

test('HTML, JSON and YAML documentation preserve technical URLs with the committed aliases', () => {
  checkDocs([
    ['links.html', `<a href="${url}" title="OpenChamber">OpenChamber</a>\n`, `<a href="${url}" title="Smarty Code">Smarty Code</a>\n`],
    ['relative.mdx', '<img src="../smarty-code/OpenChamber.svg" alt="OpenChamber" />\n', '<img src="../smarty-code/OpenChamber.svg" alt="Smarty Code" />\n'],
    ['links.json', `{"title":"OpenChamber","url":"${url}"}\n`, `{"title":"Smarty Code","url":"${url}"}\n`],
    ['links.yaml', `title: OpenChamber\nurl: ${url}\n`, `title: Smarty Code\nurl: ${url}\n`],
    ['frontmatter.mdx', `---\ntitle: OpenChamber\nurl: ${url}\n---\nOpenChamber\n`, `---\ntitle: Smarty Code\nurl: ${url}\n---\nSmarty Code\n`],
  ]);
});

test('response-policy ownership successors enumerate only six existing donor paths and retain predecessors', () => {
  const overlay = JSON.parse(readFileSync(path.join(root, 'branding/http-response-policy-overlay.json'), 'utf8'));
  assert.equal(overlay.sourceHead, '7a37d3a4b7ec75e64c8848bd7267333096c4eed1');
  assert.equal(overlay.baseHead, '91f3e0c98dcb29e84d850798ce2380245d479743');
  assert.deepEqual(overlay.files.map(entry => entry.path), ['branding/generated.json', 'packages/web/README.md',
    'packages/web/server/index.js', 'packages/web/server/lib/opencode/pwa-manifest-routes.js',
    'packages/web/server/lib/opencode/static-routes-runtime.js', 'scripts/apply-brand.mjs']);
  assert.equal(new Set(overlay.files.map(entry => entry.path)).size, 6);
  for (const entry of overlay.files) {
    assert.match(entry.predecessorSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(entry.sha256, entry.predecessorSha256);
    assert.ok(entry.note);
  }
});

test('web response-policy README section is regenerated from the branding source exactly once', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'b1190-'));
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'branding/generated.json'), 'utf8'));
    for (const file of ['branding/brand.json', 'branding/logo.svg', 'branding/symbol-template.svg',
      'branding/generated.json', ...Object.keys(manifest.files)]) {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(fixture, file));
    }
    const web = path.join(fixture, 'packages/web/README.md');
    writeFileSync(web, readFileSync(web, 'utf8').replace(/### Embedded server response policy\n[\s\S]*?(?=### Tunnel behavior notes)/, ''));
    let output;
    for (const args of [[], ['--check'], []]) {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/apply-brand.mjs'), '--root', fixture, ...args],
        { encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 0, result.stderr);
      const current = readFileSync(web, 'utf8');
      assert.equal(current.split('### Embedded server response policy').length, 2);
      assert.ok(current.includes('(server/RESPONSE_POLICY.md)'));
      if (output !== undefined) assert.equal(current, output);
      output = current;
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('owning README keeps the real integration repository destination', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes(`[Smarty Code integration](${url})`));
  assert.ok(!readme.includes('https://github.com/Smarty-Pants-Inc/Smarty Code'));
});
