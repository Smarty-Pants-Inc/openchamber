import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'branding/logo.svg');
const configPath = path.join(root, 'branding/brand.json');
const manifestPath = path.join(root, 'branding/generated.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const { name: PRODUCT_NAME, mark: PRODUCT_MARK } = config;
const args = process.argv.slice(2);
const check = args.includes('--check');
const docsIndex = args.indexOf('--docs');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const previousManifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}'));
const brandNames = [...new Set(['OpenChamber', previousManifest.config?.name === PRODUCT_NAME ? undefined : previousManifest.config?.name].filter(Boolean))];
const brandText = (value) => value.replace(new RegExp(`\\b(?:${brandNames.map(escapeRegex).join('|')})\\b`, 'g'), PRODUCT_NAME);
const brandDocs = (value) => {
  const preserved = [];
  const protectedValue = value.replace(/`OpenChamber(?: Dev)?`(?: app name)?|OpenChamber-\*\.AppImage/g, (literal) => `__BRAND_COMPAT_${preserved.push(literal) - 1}__`);
  return brandText(protectedValue).replace(/__BRAND_COMPAT_(\d+)__/g, (_match, index) => preserved[Number(index)]);
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const relative = (file) => path.relative(root, file).split(path.sep).join('/');

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else files.push(file);
  }
  return files;
};

if (docsIndex !== -1) {
  const directory = path.resolve(root, args[docsIndex + 1]);
  for (const file of await walk(directory)) {
    if (!/\.(?:html|json|md|mdx|ya?ml)$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    const branded = brandDocs(source);
    if (branded !== source) await writeFile(file, branded);
  }
  process.exit(0);
}

const typedModule = `export const PRODUCT_NAME = ${JSON.stringify(PRODUCT_NAME)};\nexport const PRODUCT_MARK = ${JSON.stringify(PRODUCT_MARK)};\nexport const brandText = (value: string) => value.replace(/\\b(?:OpenChamber|OpenCode)\\b/g, PRODUCT_NAME);\n`;
const javascriptModule = typedModule.replace('(value: string)', '(value)');
const generatedText = new Map([
  ['packages/ui/src/lib/brand.generated.ts', typedModule],
  ['packages/web/brand.generated.js', javascriptModule],
  ['packages/web/brand.generated.d.ts', 'export const PRODUCT_NAME: string;\nexport const PRODUCT_MARK: string;\nexport function brandText(value: string): string;\n'],
  ['packages/electron/brand.generated.mjs', javascriptModule],
  ['packages/vscode/src/brand.generated.ts', typedModule],
]);

const patchedText = new Map();
const patchText = async (file, transform) => patchedText.set(file, transform(await readFile(path.join(root, file), 'utf8')));
const replaceRequired = (source, pattern, replacement, label) => {
  if (!pattern.test(source)) throw new Error(`Cannot find generated brand field: ${label}`);
  return source.replace(pattern, replacement);
};
const setJsonString = (source, key, value) => replaceRequired(
  source,
  new RegExp(`("${escapeRegex(key)}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`),
  (_match, prefix) => `${prefix}${JSON.stringify(value)}`,
  key,
);
const setXmlString = (source, key, value) => replaceRequired(
  source,
  new RegExp(`(<string name="${escapeRegex(key)}">)[^<]*(</string>)`),
  (_match, prefix, suffix) => `${prefix}${value}${suffix}`,
  key,
);
const setPlistString = (source, key, value) => replaceRequired(
  source,
  new RegExp(`(<key>${escapeRegex(key)}</key>\\s*<string>)[^<]*(</string>)`),
  (_match, prefix, suffix) => `${prefix}${value}${suffix}`,
  key,
);
const setSwiftString = (source, pattern, value, label) => replaceRequired(
  source,
  pattern,
  (_match, prefix) => `${prefix}${JSON.stringify(value)}`,
  label,
);

const pwaManifestFile = 'packages/web/public/site.webmanifest';
const pwaManifest = (await readFile(path.join(root, pwaManifestFile), 'utf8'))
  .replace(/("name"\s*:\s*)".*"/, `$1${JSON.stringify(`${PRODUCT_NAME} - AI Coding Companion`)}`)
  .replace(/("short_name"\s*:\s*)".*"/, `$1${JSON.stringify(PRODUCT_NAME)}`)
  .replace(/("description"\s*:\s*)".*"/, `$1${JSON.stringify(`${PRODUCT_NAME} AI coding assistant`)}`);
patchedText.set(pwaManifestFile, pwaManifest);

for (const file of [
  'README.md',
  'packages/web/README.md',
  'packages/electron/README.md',
  'packages/vscode/README.md',
  'packages/mobile/README.md',
  'packages/docs/README.md',
]) await patchText(file, brandDocs);

await patchText('package.json', (source) => setJsonString(source, 'description', `${PRODUCT_NAME} monorepo workspace for web, ui, and desktop runtimes`));
await patchText('scripts/install.sh', (source) => {
  const branded = brandText(source);
  return replaceRequired(
    branded,
    /(# brand:mark\n\s*printf )'[^']*'/,
    (_match, prefix) => `${prefix}'  ${PRODUCT_MARK}  ${PRODUCT_NAME}\\n'`,
    'installer mark',
  );
});

await patchText('packages/electron/package.json', (source) => {
  let branded = setJsonString(source, 'description', `Electron desktop runtime for ${PRODUCT_NAME}`);
  branded = setJsonString(branded, 'author', PRODUCT_NAME);
  branded = setJsonString(branded, 'productName', PRODUCT_NAME);
  branded = setJsonString(branded, 'Name', PRODUCT_NAME);
  return setJsonString(branded, 'Comment', `Desktop runtime for ${PRODUCT_NAME}`);
});
await patchText('packages/vscode/package.nls.json', (source) => {
  let branded = setJsonString(source, 'product.name', PRODUCT_NAME);
  branded = setJsonString(branded, 'extension.description', `${PRODUCT_NAME} AI coding assistant`);
  branded = setJsonString(branded, 'command.showOpenCodeStatus.title', `Show ${PRODUCT_NAME} Status`);
  return setJsonString(branded, 'configuration.apiUrl.description', 'URL of an external agent API server. Leave empty to auto-start a local instance.');
});
await patchText('packages/vscode/package.nls.fr.json', (source) => {
  let branded = setJsonString(source, 'product.name', PRODUCT_NAME);
  branded = setJsonString(branded, 'extension.description', `${PRODUCT_NAME}, assistant de codage IA`);
  branded = setJsonString(branded, 'command.showOpenCodeStatus.title', `Afficher l’état de ${PRODUCT_NAME}`);
  return setJsonString(branded, 'configuration.apiUrl.description', 'URL d’un serveur API d’agent externe. Laissez vide pour démarrer automatiquement une instance locale.');
});
await patchText('packages/vscode/webview/index.html', (source) => replaceRequired(
  source,
  /(<title>)[^<]*(<\/title>)/,
  (_match, prefix, suffix) => `${prefix}${PRODUCT_NAME}${suffix}`,
  'VS Code webview title',
));
await patchText('packages/mobile/capacitor.config.ts', (source) => replaceRequired(
  source,
  /(\bappName:\s*)'[^']*'/,
  (_match, prefix) => `${prefix}'${PRODUCT_NAME}'`,
  'Capacitor appName',
));
await patchText('packages/mobile/android/app/src/main/res/values/strings.xml', (source) => {
  let branded = setXmlString(source, 'app_name', PRODUCT_NAME);
  return setXmlString(branded, 'title_activity_main', PRODUCT_NAME);
});
await patchText('packages/mobile/android/app/src/main/res/values/ic_launcher_background.xml', (source) => replaceRequired(
  source,
  /(<color name="ic_launcher_background">)[^<]*(<\/color>)/,
  '$1#151313$2',
  'Android launcher background',
));
await patchText('packages/mobile/ios/App/App/Info.plist', (source) => {
  let branded = setPlistString(source, 'CFBundleDisplayName', PRODUCT_NAME);
  branded = setPlistString(branded, 'NSLocalNetworkUsageDescription', `${PRODUCT_NAME} connects to ${PRODUCT_NAME} servers on your local network.`);
  branded = setPlistString(branded, 'NSCameraUsageDescription', `${PRODUCT_NAME} uses the camera to scan a server's pairing QR code.`);
  return setPlistString(branded, 'NSMicrophoneUsageDescription', `${PRODUCT_NAME} uses the microphone for voice dictation in the chat composer.`);
});
await patchText('packages/mobile/ios/App/OpenChamberWidget/Info.plist', (source) => setPlistString(source, 'CFBundleDisplayName', PRODUCT_NAME));
await patchText('packages/mobile/ios/App/OpenChamberWidget/WidgetShared.swift', (source) => setSwiftString(
  source,
  /(struct CubeLogoView: View \{[\s\S]*?\bText\()"[^"]*"/,
  PRODUCT_MARK,
  'widget mark',
));
await patchText('packages/mobile/ios/App/OpenChamberWidget/OpenChamberControl.swift', (source) => {
  const branded = setSwiftString(source, /(static let title: LocalizedStringResource = )"[^"]*"/, `New ${PRODUCT_NAME} session`, 'control title');
  return setSwiftString(branded, /(} icon: \{\s*Text\()"[^"]*"/, PRODUCT_MARK, 'control mark');
});
await patchText('packages/mobile/ios/App/OpenChamberWidget/OpenChamberWidgets.swift', (source) => {
  const branded = setSwiftString(source, /(configurationDisplayName\()"[^"]*"/, PRODUCT_NAME, 'widget overview name');
  return setSwiftString(branded, /(description\()"Start a new [^"]* session\."/, `Start a new ${PRODUCT_NAME} session.`, 'widget control description');
});
const logoSvg = await readFile(sourcePath, 'utf8');
const nerdOutlineSvg = (color = '#000') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="5"><circle cx="32" cy="32" r="28"/><rect x="9" y="19" width="20" height="16" rx="7"/><rect x="35" y="19" width="20" height="16" rx="7"/><path d="M29 25h6M17 43c8 8 22 8 30 0"/></g><path fill="${color}" d="M27 45h10v6H27z"/></svg>\n`;
for (const file of [
  'packages/web/public/favicon.svg',
  'packages/web/public/apple-touch-icon.svg',
  'packages/web/public/logo-dark-512x512.svg',
  'packages/web/public/logo-light-512x512.svg',
  'packages/electron/resources/icons/app-icon.svg',
  'packages/electron/resources/icons/icon-win.svg',
  'docs/references/badges/openchamber-logo-dark.svg',
  'docs/references/badges/openchamber-logo-light.svg',
]) generatedText.set(file, logoSvg);

generatedText.set('packages/web/public/mask-icon.svg', nerdOutlineSvg());
generatedText.set('packages/vscode/assets/icon.svg', nerdOutlineSvg());
generatedText.set('packages/vscode/assets/icon-titlebar.svg', nerdOutlineSvg('#fff'));
generatedText.set('packages/mobile/ios/App/OpenChamberWidget/Assets.xcassets/OCLogoSymbol.symbolset/oclogo-symbol.svg', nerdOutlineSvg());
generatedText.set('packages/mobile/android/app/src/main/res/drawable/ic_stat_notify.xml', `<!-- Monochrome nerd mark for Android's tinted notification surface. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#00000000"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="1.8"
        android:strokeLineJoin="round"
        android:strokeLineCap="round"
        android:pathData="M12,2.5 A9.5,9.5 0,1 1,11.99 2.5 M7.5,7.2 A3.6,3.6 0,1 1,7.49 7.2 M16.5,7.2 A3.6,3.6 0,1 1,16.49 7.2 M11.1,9.4 L12.9,9.4 M7.5,15 C9.6,18 14.4,18 16.5,15" />
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M10.4,15.8 L13.6,15.8 L13.6,18 L10.4,18 Z" />
</vector>
`);

for (const [file, content] of generatedText) {
  const absolute = path.join(root, file);
  if (check) {
    if (await readFile(absolute, 'utf8').catch(() => '') !== content) throw new Error(`Stale generated brand file: ${file}`);
  } else {
    await writeFile(absolute, content);
  }
}

for (const [file, content] of patchedText) {
  const absolute = path.join(root, file);
  const source = await readFile(absolute, 'utf8');
  if (check) {
    if (source !== content) throw new Error(`Stale brand field: ${file}`);
  } else if (source !== content) {
    await writeFile(absolute, content);
  }
}

const pngs = [
  ...(await walk(path.join(root, 'packages/web/public'))).filter((file) => /\/(?:apple-touch-icon[^/]*|favicon(?:-\d+)?|logo-(?:dark|light)-192x192|pwa(?:-maskable)?-(?:192|512))\.png$/.test(file)),
  ...(await walk(path.join(root, 'packages/electron/resources/icons'))).filter((file) => file.endsWith('.png') && !file.includes('/AppIcon.icon/') && !file.includes('/tray/status/')),
  path.join(root, 'packages/vscode/assets/app-icon.png'),
  path.join(root, 'docs/references/badges/openchamber-logo-dark.png'),
  ...(await walk(path.join(root, 'packages/mobile/assets'))).filter((file) => file.endsWith('.png')),
  ...(await walk(path.join(root, 'packages/mobile/android/app/src/main/res'))).filter((file) => /\/(?:ic_launcher(?:_background|_foreground|_round)?|splash)\.png$/.test(file)),
  ...(await walk(path.join(root, 'packages/mobile/ios/App/App/Assets.xcassets'))).filter((file) => /\/(?:AppIcon-512@2x|splash-2732x2732(?:-[12])?)\.png$/.test(file)),
];

const background = { r: 21, g: 19, b: 19, alpha: 1 };
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const nerdSvg = (unseen = false) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="6"><circle cx="32" cy="32" r="27"/><rect x="8" y="18" width="21" height="17" rx="7"/><rect x="35" y="18" width="21" height="17" rx="7"/><path d="M29 25h6M17 43c8 8 22 8 30 0"/></g><path d="M27 45h10v7H27z"/>${unseen ? '<circle cx="55" cy="9" r="7"/>' : ''}</svg>`);

const renderPngs = async () => {
  const { default: sharp } = await import('sharp');
  for (const file of pngs) {
    const { width, height } = await sharp(file).metadata();
    if (!width || !height) throw new Error(`Cannot read dimensions: ${relative(file)}`);
    const name = path.basename(file);
    const tray = file.includes('/tray/');
    const kind = tray ? 'tray'
      : name.includes('background') ? 'background'
        : name.includes('foreground') ? 'foreground'
          : name === 'splash.png' || name.startsWith('splash-') ? 'splash'
            : /(?:favicon|logo-(?:dark|light)|openchamber-logo)/.test(name) ? 'transparent'
              : 'app';
    const canvas = sharp({ create: { width, height, channels: 4, background: ['app', 'splash', 'background'].includes(kind) ? background : transparent } });
    let output = canvas;
    if (kind !== 'background') {
      const min = Math.min(width, height);
      const frame = Number(name.match(/breath-(\d+)/)?.[1] ?? 0);
      const ratio = kind === 'splash' ? 0.28 : kind === 'foreground' ? 0.72 : kind === 'tray' ? 0.78 + Math.sin(frame / 16 * Math.PI * 2) * 0.06 : kind === 'app' ? 0.9 : 1;
      const size = Math.max(1, Math.round(min * ratio));
      const input = tray
        ? await sharp(nerdSvg(name.includes('unseen'))).resize(size, size).png().toBuffer()
        : await sharp(sourcePath).resize(size, size, { fit: 'contain' }).png().toBuffer();
      output = canvas.composite([{ input, gravity: 'center' }]);
    }
    const temporary = `${file}.brand-tmp`;
    await output.png().toFile(temporary);
    await rename(temporary, file);
  }
};

const sourceDigest = hash(Buffer.concat([
  await readFile(configPath),
  await readFile(sourcePath),
  await readFile(fileURLToPath(import.meta.url)),
]));

if (!check) await renderPngs();

const files = [...generatedText.keys(), ...pngs.map(relative)].sort();
if (check) {
  const manifest = previousManifest;
  if (manifest.source !== sourceDigest) throw new Error('Generated brand assets are stale');
  for (const file of files) {
    const actual = hash(await readFile(path.join(root, file)));
    if (manifest.files?.[file] !== actual) throw new Error(`Generated brand asset changed: ${file}`);
  }
} else {
  const hashes = Object.fromEntries(await Promise.all(files.map(async (file) => [file, hash(await readFile(path.join(root, file)))])));
  await writeFile(manifestPath, `${JSON.stringify({ config, source: sourceDigest, files: hashes })}\n`);
}
