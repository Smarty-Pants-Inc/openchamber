import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify, visit } from 'yaml';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = rootIndex === -1 ? defaultRoot : path.resolve(args[rootIndex + 1]);
const sourcePath = path.join(root, 'branding/logo.svg');
const configPath = path.join(root, 'branding/brand.json');
const manifestPath = path.join(root, 'branding/generated.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const { name: PRODUCT_NAME, mark: PRODUCT_MARK, presentationAliases = ['OpenChamber'] } = config;
const check = args.includes('--check');
const docsIndex = args.indexOf('--docs');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character]));
const previousManifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}'));
const validateBrandValue = (label, value) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`branding/brand.json ${label} must be a non-empty string`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`branding/brand.json ${label} must not contain control characters`);
  if (/[{}]/.test(value)) throw new Error(`branding/brand.json ${label} must not contain template placeholder braces`);
};
validateBrandValue('name', PRODUCT_NAME);
validateBrandValue('mark', PRODUCT_MARK);
if (!Array.isArray(presentationAliases)) throw new Error('branding/brand.json presentationAliases must be an array');
for (const alias of presentationAliases) validateBrandValue('presentationAliases entries', alias);
const configuredBrandNames = [...new Set(presentationAliases)];
if (configuredBrandNames.length === 0) throw new Error('branding/brand.json presentationAliases must contain at least one non-empty string');
const brandNames = [...new Set(['OpenChamber', 'OpenChambers', ...configuredBrandNames])].sort((a, b) => b.length - a.length);
const aliasPattern = `(?<!\\w)(?:${brandNames.map(escapeRegex).join('|')})(?!\\w)`;
const brandRegex = new RegExp(aliasPattern, 'g');
const brandText = (value) => value.replace(brandRegex, () => PRODUCT_NAME);
const documentationBrandNames = brandNames.filter((name) => name !== 'OpenCode');
if (documentationBrandNames.length === 0) throw new Error('branding/brand.json presentationAliases must include a product alias other than OpenCode');
const documentationBrandRegex = new RegExp(`(?<!\\w)(?:${documentationBrandNames.map(escapeRegex).join('|')})(?!\\w)`, 'g');
const documentationElisionRegex = brandNames.includes('OpenChamber') ? /([qQ]u|[dDlL])([’'])(OpenChamber|OpenChambers)\b/g : /(?!)/g;
const documentationProductRegex = new RegExp(`${documentationElisionRegex.source}|${documentationBrandRegex.source}`, 'g');
const documentationProductText = (value, productName) => value.replace(documentationProductRegex, (_match, prefix) => {
  if (!prefix) return productName;
  return prefix === 'Qu' ? `Que ${productName}` : prefix === 'D' ? `De ${productName}` : prefix === 'L' ? `Le ${productName}` : prefix.toLowerCase() === 'qu' ? `que ${productName}` : prefix.toLowerCase() === 'd' ? `de ${productName}` : `le ${productName}`;
});
const documentationBrandText = (value) => documentationProductText(value, PRODUCT_NAME);
const documentationBrandTextForDocs = (value) => documentationProductText(value, escapeHtml(PRODUCT_NAME));
const documentationBrandTextForJson = (value) => documentationProductText(value, JSON.stringify(PRODUCT_NAME).slice(1, -1));
const brandYamlDocumentation = (value) => {
  const indentation = value.match(/^(?<indent>[ \t]*)\S/m)?.groups?.indent ?? '';
  const normalized = indentation ? value.split('\n').map((line) => line.startsWith(indentation) ? line.slice(indentation.length) : line).join('\n') : value;
  const document = parseDocument(normalized);
  if (document.errors.length > 0) {
    if (documentationBrandText(normalized) !== normalized) throw new Error('Cannot safely brand invalid YAML documentation');
    return value;
  }
  const replacements = [];
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value !== 'string' || !node.range) return;
      const branded = documentationBrandText(node.value);
      if (branded !== node.value) replacements.push({ start: node.range[0], end: node.range[1], text: stringify(branded).trimEnd() });
    },
  });
  let output = normalized;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`;
  }
  return output.split('\n').map((line) => line ? `${indentation}${line}` : line).join('\n');
};
const brandFencedDocumentation = (token) => {
  const match = token.match(/^(\`{3}|~{3})([^\n]*)\n([\s\S]*?)\n([ \t]*)\1\s*$/);
  if (!match) return token;
  const language = match[2].trim().toLowerCase();
  if (!['md', 'mdx', 'markdown', 'json', 'yaml', 'yml'].includes(language)) return token;
  const body = language === 'md' || language === 'mdx' || language === 'markdown'
    ? brandDocs(match[3])
    : language === 'json' ? documentationBrandTextForJson(match[3]) : brandYamlDocumentation(match[3]);
  return `${match[1]}${match[2]}\n${body}\n${match[4]}${match[1]}`;
};
const brandDocs = (value) => {
  const frontmatter = value.match(/^(---\n|---\r\n)([\s\S]*?)(\n---(?=\n|$)|\r\n---(?=\r\n|$))/);
  if (frontmatter) {
    const body = value.slice(frontmatter[0].length);
    return `${frontmatter[1]}${brandYamlDocumentation(frontmatter[2])}${frontmatter[3]}${brandDocs(body)}`;
  }
  const code = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
  let branded = '';
  let cursor = 0;
  for (const match of value.matchAll(code)) {
    branded += documentationBrandTextForDocs(value.slice(cursor, match.index));
    branded += brandFencedDocumentation(match[0]);
    cursor = match.index + match[0].length;
  }
  return branded + documentationBrandTextForDocs(value.slice(cursor));
};
const hash = (value) => createHash('sha256').update(value).digest('hex');

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
    const extension = path.extname(file).toLowerCase();
    const branded = extension === '.json' ? documentationBrandTextForJson(source)
      : extension === '.yaml' || extension === '.yml' ? brandYamlDocumentation(source)
        : brandDocs(source);
    if (check && branded !== source) throw new Error(`Stale branded docs: ${path.relative(root, file)}`);
    if (!check && branded !== source) await writeFile(file, branded);
  }
  process.exit(0);
}

const documentationProductReplacement = "(_match: string, prefix: string) => prefix ? (prefix === 'Qu' ? 'Que ' + PRODUCT_NAME : prefix === 'D' ? 'De ' + PRODUCT_NAME : prefix === 'L' ? 'Le ' + PRODUCT_NAME : prefix.toLowerCase() === 'qu' ? 'que ' + PRODUCT_NAME : prefix.toLowerCase() === 'd' ? 'de ' + PRODUCT_NAME : 'le ' + PRODUCT_NAME) : PRODUCT_NAME";
const typedModule = `export const PRODUCT_NAME = ${JSON.stringify(PRODUCT_NAME)};\nexport const PRODUCT_MARK = ${JSON.stringify(PRODUCT_MARK)};\nexport const brandText = (template: string) => template.replace(/${brandRegex.source}/g, () => PRODUCT_NAME);\nexport const brandProductText = (template: string) => template.replace(/${documentationProductRegex.source}/g, ${documentationProductReplacement});\n`;
const javascriptModule = typedModule.replaceAll('(template: string)', '(template)').replaceAll('(_match: string, prefix: string)', '(_match, prefix)');
const generatedText = new Map([
  ['packages/ui/src/lib/brand.generated.ts', typedModule],
  ['packages/web/brand.generated.js', javascriptModule],
  ['packages/web/brand.generated.d.ts', 'export const PRODUCT_NAME: string;\nexport const PRODUCT_MARK: string;\nexport function brandText(template: string): string;\nexport function brandProductText(template: string): string;\n'],
  ['packages/electron/brand.generated.mjs', javascriptModule],
  ['packages/vscode/src/brand.generated.ts', typedModule],
]);

const patchedText = new Map();
const patchText = async (file, transform) => patchedText.set(file, transform(await readFile(path.join(root, file), 'utf8')));
const replaceRequired = (source, pattern, replacement, label) => {
  if (!pattern.test(source)) throw new Error(`Cannot find generated brand field: ${label}`);
  return source.replace(pattern, replacement);
};
const setJsonString = (source, key, value, label = key) => replaceRequired(
  source,
  new RegExp(`("${escapeRegex(key)}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`),
  (_match, prefix) => `${prefix}${JSON.stringify(value)}`,
  label,
);
const escapeXml = (value) => String(value).replace(/[&<>]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
}[character]));
const escapeDesktopEntryValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
const escapeAndroidResource = (value) => escapeXml(value)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/"/g, '\\"')
  .replace(/^([@?])/, '\\$1');
const setXmlString = (source, key, value) => replaceRequired(
  source,
  new RegExp(`(<string name="${escapeRegex(key)}">)[^<]*(</string>)`),
  (_match, prefix, suffix) => `${prefix}${escapeXml(value)}${suffix}`,
  key,
);
const setAndroidResourceString = (source, key, value) => replaceRequired(
  source,
  new RegExp(`(<string name="${escapeRegex(key)}">)[^<]*(</string>)`),
  (_match, prefix, suffix) => `${prefix}${escapeAndroidResource(value)}${suffix}`,
  key,
);
const setPlistString = (source, key, value) => replaceRequired(
  source,
  new RegExp(`(<key>${escapeRegex(key)}</key>\\s*<string>)[^<]*(</string>)`),
  (_match, prefix, suffix) => `${prefix}${escapeXml(value)}${suffix}`,
  key,
);
const setPbxString = (source, key, value) => replaceRequired(
  source,
  new RegExp(`(${escapeRegex(key)}\\s*=\\s*)[^;]+;`, 'g'),
  (_match, prefix) => `${prefix}${/^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value)};`,
  key,
);
const setSwiftString = (source, pattern, value, label) => replaceRequired(
  source,
  pattern,
  (_match, prefix) => `${prefix}${JSON.stringify(value)}`,
  label,
);
const escapeShellDoubleQuoted = (value) => String(value).replace(/[$`\\"]/g, (character) => `\\${character}`);
const escapeShellSingleQuoted = (value) => String(value).replace(/'/g, () => "'\\''");

await patchText('packages/web/public/site.webmanifest', (source) => {
  let branded = setJsonString(source, 'name', `${PRODUCT_NAME} - AI Coding Companion`, 'PWA name');
  branded = setJsonString(branded, 'short_name', PRODUCT_NAME, 'PWA short_name');
  return setJsonString(branded, 'description', `${PRODUCT_NAME} web interface companion for OpenCode AI coding agent`, 'PWA description');
});
for (const file of ['docs/REVERSE_PROXY.md', 'docs/CUSTOM_THEMES.md']) await patchText(file, brandDocs);

await patchText('README.md', (source) => {
  const branded = brandDocs(source);
  const headingMark = escapeHtml(PRODUCT_MARK);
  const headingName = escapeHtml(PRODUCT_NAME);
  return replaceRequired(
    branded,
    /^(# <img src="docs\/references\/badges\/openchamber-logo-dark\.png" width="32" height="32" align="absmiddle" alt=")[^"]*(" \/> )[^\x0a]+$/m,
    (_match, prefix, suffix) => `${prefix}${headingMark}${suffix}${headingName}`,
    'README brand heading',
  );
});
for (const file of [
  'packages/web/README.md',
  'packages/electron/README.md',
  'packages/vscode/README.md',
  'packages/mobile/README.md',
  'packages/docs/README.md',
]) await patchText(file, brandDocs);
await patchText('scripts/install.sh', (source) => {
  const shellName = escapeShellDoubleQuoted(PRODUCT_NAME);
  let branded = replaceRequired(source, /^# .* Install Script$/m, () => `# ${PRODUCT_NAME} Install Script`, 'installer header');
  const bannerTitle = `   ${shellName} Installer`.padEnd(35);
  const bannerSubtitle = '   AI coding workspace'.padEnd(35);
  branded = replaceRequired(branded, /^  echo "  │.*Installer.*│"$/m, () => `  echo "  │${bannerTitle}│"`, 'installer banner title');
  branded = replaceRequired(branded, /^  echo "  │   (?:Web interface for .*|AI coding workspace)\s*│"$/m, () => `  echo "  │${bannerSubtitle}│"`, 'installer banner subtitle');
  branded = replaceRequired(branded, /^    info ".* is already installed — updating via 'openchamber update'\.\.\."$/m, () => `    info "${shellName} is already installed — updating via 'openchamber update'..."`, 'installer update message');
  branded = replaceRequired(branded, /^      success ".* is up to date!"$/m, () => `      success "${shellName} is up to date!"`, 'installer updated message');
  branded = replaceRequired(branded, /^  info "Installing .*\.\.\."$/m, () => `  info "Installing ${shellName}..."`, 'installer installing message');
  branded = replaceRequired(branded, /(# brand:mark\n\s*printf ).*$/m, (_match, prefix) => `${prefix}'%s\\n' '${escapeShellSingleQuoted(`  ${PRODUCT_MARK}  ${PRODUCT_NAME}`)}'`, 'installer mark');
  branded = replaceRequired(branded, /^    success ".* installed successfully!"$/m, () => `    success "${shellName} installed successfully!"`, 'installer success message');
  return replaceRequired(branded, /^    echo "    Make sure .*: opencode serve"$/m, '    echo "    Make sure opencode is running: opencode serve"', 'installer prerequisite');
});

await patchText('packages/electron/package.json', (source) => {
  const desktopName = escapeDesktopEntryValue(PRODUCT_NAME);
  let branded = setJsonString(source, 'description', `Electron desktop runtime for ${PRODUCT_NAME}`);
  branded = setJsonString(branded, 'author', PRODUCT_NAME);
  branded = setJsonString(branded, 'productName', PRODUCT_NAME);
  branded = setJsonString(branded, 'Name', desktopName);
  return setJsonString(branded, 'Comment', `Desktop runtime for ${desktopName}`);
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
const brandOwnedLocaleBundle = (source) => {
  const values = JSON.parse(source);
  const branded = Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key.replace(documentationBrandRegex, () => PRODUCT_NAME),
    value.replace(documentationBrandRegex, () => PRODUCT_NAME),
  ]));
  return `${JSON.stringify(branded, null, 2)}\n`;
};
for (const file of ['packages/vscode/l10n/bundle.l10n.json', 'packages/vscode/l10n/bundle.l10n.fr.json']) {
  await patchText(file, brandOwnedLocaleBundle);
}
await patchText('packages/vscode/webview/index.html', (source) => replaceRequired(
  source,
  /(<title>)[^<]*(<\/title>)/,
  (_match, prefix, suffix) => `${prefix}${escapeXml(PRODUCT_NAME)}${suffix}`,
  'VS Code webview title',
));
await patchText('packages/mobile/capacitor.config.ts', (source) => replaceRequired(
  source,
  /(\bappName:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/,
  (_match, prefix) => `${prefix}${JSON.stringify(PRODUCT_NAME)}`,
  'Capacitor appName',
));
await patchText('packages/mobile/android/app/src/main/res/values/strings.xml', (source) => {
  let branded = setAndroidResourceString(source, 'app_name', PRODUCT_NAME);
  return setAndroidResourceString(branded, 'title_activity_main', PRODUCT_NAME);
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
await patchText('packages/mobile/ios/App/App.xcodeproj/project.pbxproj', (source) => setPbxString(
  source,
  'INFOPLIST_KEY_CFBundleDisplayName',
  PRODUCT_NAME,
));
await patchText('packages/mobile/ios/App/OpenChamberWidget/WidgetShared.swift', (source) => setSwiftString(
  source,
  /(struct CubeLogoView: View \{[\s\S]*?\bText\()"(?:\\.|[^"\\])*"/,
  PRODUCT_MARK,
  'widget mark',
));
await patchText('packages/mobile/ios/App/OpenChamberWidget/OpenChamberControl.swift', (source) => {
  const withTitle = setSwiftString(source, /(static let title: LocalizedStringResource = )"(?:\\.|[^"\\])*"/, `New ${PRODUCT_NAME} session`, 'control title');
  const withDescription = setSwiftString(withTitle, /(description\()"Start a new (?:\\.|[^"\\])* session\."/, `Start a new ${PRODUCT_NAME} session.`, 'control description');
  return setSwiftString(withDescription, /(} icon: \{\s*Text\()"(?:\\.|[^"\\])*"/, PRODUCT_MARK, 'control mark');
});
await patchText('packages/mobile/ios/App/OpenChamberWidget/OpenChamberWidgets.swift', (source) => {
  const branded = setSwiftString(source, /(configurationDisplayName\()"(?:\\.|[^"\\])*"/, PRODUCT_NAME, 'widget overview name');
  return setSwiftString(branded, /(description\()"Start a new (?:\\.|[^"\\])* session\."/, `Start a new ${PRODUCT_NAME} session.`, 'widget control description');
});

const logoSvg = await readFile(sourcePath, 'utf8');
const monochromeLogoSvg = (color) => {
  let svg = logoSvg.replace(/\s*<defs>[\s\S]*?<\/defs>/, '');
  svg = svg.replace(/(<(?:circle|ellipse|rect|path|polygon)\b[^>]*\bfill=")(?!none)[^"]*"/, '$1none"');
  svg = svg.replace(/\b(fill|stroke)="(?!none)[^"]*"/g, (_match, attribute) => `${attribute}="${color}"`);
  return `${svg.trimEnd()}\n`;
};
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
generatedText.set('packages/web/public/mask-icon.svg', monochromeLogoSvg('#000'));
generatedText.set('packages/vscode/assets/icon.svg', monochromeLogoSvg('currentColor'));
generatedText.set('packages/vscode/assets/icon-titlebar.svg', monochromeLogoSvg('#fff'));
generatedText.set('packages/mobile/ios/App/OpenChamberWidget/Assets.xcassets/OCLogoSymbol.symbolset/oclogo-symbol.svg', monochromeLogoSvg('#000'));

const pngTargets = [
  { file: 'docs/references/badges/openchamber-logo-dark.png', width: 512, height: 512 },
  { file: 'packages/electron/resources/icons/app-icon.png', width: 512, height: 512 },
  { file: 'packages/electron/resources/icons/dev-icon.png', width: 1024, height: 1024 },
  { file: 'packages/electron/resources/icons/icon.png', width: 1024, height: 1024 },
  ...Array.from({ length: 16 }, (_, frame) => ({ file: `packages/electron/resources/icons/tray/trayTemplate-breath-${String(frame).padStart(2, '0')}.png`, width: 18, height: 18 })),
  ...Array.from({ length: 16 }, (_, frame) => ({ file: `packages/electron/resources/icons/tray/trayTemplate-breath-${String(frame).padStart(2, '0')}@2x.png`, width: 36, height: 36 })),
  { file: 'packages/electron/resources/icons/tray/trayTemplate-idle.png', width: 18, height: 18 },
  { file: 'packages/electron/resources/icons/tray/trayTemplate-idle@2x.png', width: 36, height: 36 },
  { file: 'packages/electron/resources/icons/tray/trayTemplate-unseen.png', width: 18, height: 18 },
  { file: 'packages/electron/resources/icons/tray/trayTemplate-unseen@2x.png', width: 36, height: 36 },
  { file: 'packages/mobile/android/app/src/main/res/drawable/ic_stat_notify.png', width: 96, height: 96 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-land-hdpi/splash.png', width: 800, height: 480 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-land-mdpi/splash.png', width: 480, height: 320 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-land-xhdpi/splash.png', width: 1280, height: 720 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-land-xxhdpi/splash.png', width: 1600, height: 960 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-land-xxxhdpi/splash.png', width: 1920, height: 1280 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-port-hdpi/splash.png', width: 480, height: 800 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-port-mdpi/splash.png', width: 320, height: 480 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-port-xhdpi/splash.png', width: 720, height: 1280 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-port-xxhdpi/splash.png', width: 960, height: 1600 },
  { file: 'packages/mobile/android/app/src/main/res/drawable-port-xxxhdpi/splash.png', width: 1280, height: 1920 },
  { file: 'packages/mobile/android/app/src/main/res/drawable/splash.png', width: 480, height: 320 },
  ...Object.entries({ ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }).flatMap(([density, size]) => [
    'ic_launcher.png',
    'ic_launcher_background.png',
    'ic_launcher_foreground.png',
    'ic_launcher_round.png',
  ].map((name) => ({ file: `packages/mobile/android/app/src/main/res/mipmap-${density}/${name}`, width: size, height: size }))),
  { file: 'packages/mobile/assets/icon-background.png', width: 1024, height: 1024 },
  { file: 'packages/mobile/assets/icon-foreground.png', width: 1024, height: 1024 },
  { file: 'packages/mobile/assets/icon-only.png', width: 1024, height: 1024 },
  { file: 'packages/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', width: 1024, height: 1024 },
  { file: 'packages/mobile/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png', width: 2732, height: 2732 },
  { file: 'packages/mobile/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png', width: 2732, height: 2732 },
  { file: 'packages/mobile/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png', width: 2732, height: 2732 },
  { file: 'packages/vscode/assets/app-icon.png', width: 512, height: 512 },
  { file: 'packages/web/public/apple-touch-icon-120x120.png', width: 120, height: 120 },
  { file: 'packages/web/public/apple-touch-icon-152x152.png', width: 152, height: 152 },
  { file: 'packages/web/public/apple-touch-icon-167x167.png', width: 167, height: 167 },
  { file: 'packages/web/public/apple-touch-icon-180x180.png', width: 180, height: 180 },
  { file: 'packages/web/public/apple-touch-icon.png', width: 180, height: 180 },
  { file: 'packages/web/public/favicon-16.png', width: 16, height: 16 },
  { file: 'packages/web/public/favicon-32.png', width: 32, height: 32 },
  { file: 'packages/web/public/favicon.png', width: 64, height: 64 },
  { file: 'packages/web/public/logo-dark-192x192.png', width: 192, height: 192 },
  { file: 'packages/web/public/logo-light-192x192.png', width: 192, height: 192 },
  { file: 'packages/web/public/pwa-192.png', width: 192, height: 192 },
  { file: 'packages/web/public/pwa-512.png', width: 512, height: 512 },
  { file: 'packages/web/public/pwa-maskable-192.png', width: 192, height: 192 },
  { file: 'packages/web/public/pwa-maskable-512.png', width: 512, height: 512 },
];
const obsoleteGeneratedFiles = ['packages/mobile/android/app/src/main/res/drawable/ic_stat_notify.xml'];
const background = { r: 21, g: 19, b: 19, alpha: 1 };
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

const renderPngs = async () => {
  const { default: sharp } = await import('sharp');
  const fullLogo = Buffer.from(logoSvg);
  const monochromeLogo = Buffer.from(monochromeLogoSvg('#000'));
  const whiteLogo = Buffer.from(monochromeLogoSvg('#fff'));
  for (const target of pngTargets) {
    const absolute = path.join(root, target.file);
    await mkdir(path.dirname(absolute), { recursive: true });
    const name = path.basename(target.file);
    const tray = target.file.includes('/tray/');
    const notification = name === 'ic_stat_notify.png';
    const kind = tray ? 'tray'
      : notification ? 'notification'
        : name.includes('background') ? 'background'
          : name.includes('foreground') ? 'foreground'
            : name === 'splash.png' || name.startsWith('splash-') ? 'splash'
              : /(?:favicon|logo-(?:dark|light)|openchamber-logo)/.test(name) ? 'transparent'
                : 'app';
    const canvas = sharp({
      create: {
        width: target.width,
        height: target.height,
        channels: 4,
        background: ['app', 'splash', 'background'].includes(kind) ? background : transparent,
      },
    });
    let output = canvas;
    if (kind !== 'background') {
      const min = Math.min(target.width, target.height);
      const frame = Number(name.match(/breath-(\d+)/)?.[1] ?? 0);
      const ratio = kind === 'splash' ? 0.28
        : kind === 'foreground' ? 0.72
          : kind === 'tray' ? 0.78 + Math.sin(frame / 16 * Math.PI * 2) * 0.06
            : kind === 'notification' ? 0.78
              : kind === 'app' ? 0.9
                : 1;
      const size = Math.max(1, Math.round(min * ratio));
      const source = kind === 'tray' ? monochromeLogo : kind === 'notification' ? whiteLogo : fullLogo;
      const input = await sharp(source).resize(size, size, { fit: 'contain' }).png().toBuffer();
      const composites = [{ input, gravity: 'center' }];
      if (kind === 'tray' && name.includes('unseen')) {
        const dot = Math.max(3, Math.round(min * 0.24));
        const dotSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${dot}" height="${dot}"><circle cx="${dot / 2}" cy="${dot / 2}" r="${dot / 2}" fill="#000"/></svg>`);
        composites.push({ input: dotSvg, left: target.width - dot, top: 0 });
      }
      output = canvas.composite(composites);
    }
    const temporary = `${absolute}.brand-tmp`;
    await output.png().toFile(temporary);
    await rename(temporary, absolute);
  }
};

const sourceDigest = hash(Buffer.concat([
  await readFile(configPath),
  await readFile(sourcePath),
  await readFile(fileURLToPath(import.meta.url)),
]));
const expectedFiles = [...generatedText.keys(), ...patchedText.keys(), ...pngTargets.map(({ file }) => file)].sort();
const EXPECTED_CONTROLLED_FILE_COUNT = 140;
const uniqueExpectedFiles = new Set(expectedFiles);
if (expectedFiles.length !== EXPECTED_CONTROLLED_FILE_COUNT || uniqueExpectedFiles.size !== EXPECTED_CONTROLLED_FILE_COUNT) {
  throw new Error(`Expected ${EXPECTED_CONTROLLED_FILE_COUNT} unique controlled brand outputs, found ${expectedFiles.length} (${uniqueExpectedFiles.size} unique)`);
}

for (const file of obsoleteGeneratedFiles) {
  const absolute = path.join(root, file);
  if (check) {
    if (await readFile(absolute).then(() => true).catch(() => false)) throw new Error(`Obsolete generated brand file: ${file}`);
  } else {
    await rm(absolute, { force: true });
  }
}

for (const [file, content] of generatedText) {
  const absolute = path.join(root, file);
  if (check) {
    if (await readFile(absolute, 'utf8').catch(() => '') !== content) throw new Error(`Stale generated brand file: ${file}`);
  } else {
    await mkdir(path.dirname(absolute), { recursive: true });
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

if (!check) await renderPngs();

if (check) {
  const manifestFiles = Object.keys(previousManifest.files ?? {}).sort();
  if (JSON.stringify(manifestFiles) !== JSON.stringify(expectedFiles)) throw new Error('Generated brand manifest membership changed');
  if (previousManifest.source !== sourceDigest) throw new Error('Generated brand assets are stale');
  for (const file of expectedFiles) {
    const actual = hash(await readFile(path.join(root, file)));
    if (previousManifest.files[file] !== actual) throw new Error(`Generated brand asset changed: ${file}`);
  }
} else {
  const hashes = Object.fromEntries(await Promise.all(expectedFiles.map(async (file) => [file, hash(await readFile(path.join(root, file)))])));
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({ source: sourceDigest, files: hashes })}\n`);
}
