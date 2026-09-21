import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const testRequire = createRequire(require.resolve('@playwright/test/package.json'));
const playwrightRequire = createRequire(testRequire.resolve('playwright/package.json'));
const core = dirname(playwrightRequire.resolve('playwright-core/package.json'));
const executable = chromium.executablePath();
const manifest = JSON.parse(readFileSync(join(core, 'browsers.json'), 'utf8'));
const version = JSON.parse(readFileSync(require.resolve('@playwright/test/package.json'), 'utf8')).version;
if (version !== '1.63.0') throw new Error('Unexpected Playwright version');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH || !executable.startsWith(`${process.env.PLAYWRIGHT_BROWSERS_PATH}/`)) {
  throw new Error('Browser is not in the isolated job-owned browser directory');
}
writeFileSync('.auth-ui-proof/browser-custody.json', JSON.stringify({
  version, manifest, executable,
  sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
}, null, 2));
