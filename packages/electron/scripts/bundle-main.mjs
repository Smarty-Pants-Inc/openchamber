/**
 * Bundle main.mjs into a single file. Small electron-* helper deps are
 * inlined; everything else — including the in-process web server
 * (@openchamber/web) and native modules — stays external so it resolves
 * from node_modules at runtime inside the packaged app.
 *
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const updaterE2eBuild = process.env.OPENCHAMBER_UPDATER_E2E_BUILD === '1';

const result = await Bun.build({
  entrypoints: [path.join(root, 'main.mjs')],
  outdir: path.join(root, 'dist-bundle'),
  target: 'node',
  format: 'esm',
  external: [
    'electron',
    '@openchamber/web',
    '@openchamber/web/*',
  ],
  minify: false,
  sourcemap: 'none',
  naming: '[name].mjs',
  define: {
    __OPENCHAMBER_UPDATER_E2E_BUILD__: updaterE2eBuild ? 'true' : 'false',
  },
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

console.log(`[electron] main.mjs bundled -> dist-bundle/main.mjs (updater E2E=${updaterE2eBuild})`);
