// Builds coedit-fs for the co-edit tests (openchamber#380). ponytail: here and not as a CI step, because the workflow
// and package.json files are bound by the branding ledger (openchamber#356's test:brand rule). cargo is incremental and
// holds its own build lock, so every test file may call this. Without cargo the tests skip locally; in CI they fail.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function ensureHelper() {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(import.meta.dirname, 'Cargo.toml')],
      { stdio: ['ignore', 'ignore', 'inherit'] });
    return true;
  } catch (error) {
    if (process.env.CI) throw new Error(`coedit-fs did not build: ${error.message}`);
    return false;
  }
}
