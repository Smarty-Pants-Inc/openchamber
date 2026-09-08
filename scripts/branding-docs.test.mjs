import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('owning README keeps the real integration repository destination', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes(`[Smarty Code integration](${url})`));
  assert.ok(!readme.includes('https://github.com/Smarty-Pants-Inc/Smarty Code'));
});
