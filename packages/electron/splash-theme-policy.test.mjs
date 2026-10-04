import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { attachRendererRecovery } from './renderer-recovery.mjs';
import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';
import { replaceFileWithRetry } from './windows-file-replace.mjs';
import { PRODUCT_NAME, PRODUCT_MARK } from './brand.generated.mjs';

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const mainSource = await fs.readFile(path.join(packageDirectory, 'main.mjs'), 'utf8');

const sourceSection = (start, end) => {
  const first = mainSource.indexOf(start);
  const last = mainSource.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `production section missing: ${start}`);
  return mainSource.slice(first, last);
};

// Execute the production receivers, settings IO, and HTML producer unchanged.
// Only Electron's native registration/window boundary is supplied by the test.
const productionSource = [
  sourceSection('const settingsFilePath =', 'const sshManager ='),
  sourceSection('const readJsonFile =', '// Stable per-install identifier'),
  sourceSection('const STARTUP_PERF_ENABLED_VALUES =', 'const LOG_MAX_AGE_MS ='),
  sourceSection('const MIN_WINDOW_WIDTH =', 'const MAX_CAPTURE_PAGE_RECT_AREA ='),
  sourceSection('const normalizeHostUrl =', 'const readDesktopLocalClientToken ='),
  sourceSection('const packagedUiOrigin =', 'const injectRuntimeConfigIntoHtml ='),
  sourceSection('const macosMajorVersion =', '// Keep the main window aligned'),
  sourceSection('const escapeHtml =', 'const extractCookieHeader ='),
  sourceSection('const nextWindowLabel =', 'const activateMainWindow ='),
  sourceSection('const handleInvoke =', 'const buildMacMenu ='),
  sourceSection('const isLocalSender =', "ipcMain.handle('openchamber:dialog:open'"),
  `globalThis.receiver = { buildStartupSplashHtml, createBrowserWindow, readThemeSource, handleInvoke,
    remoteThemeAllowed: COMMANDS_SAFE_FOR_REMOTE.has('desktop_set_window_theme'),
    drain: () => settingsMutationChain };`,
].join('\n');

const fixture = async (settings = {}, preferences = {}, isDev = false) => {
  const fixtureRoot = path.resolve(packageDirectory, '../../.local');
  await fs.mkdir(fixtureRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtureRoot, 'splash-policy-'));
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings));
  await fs.writeFile(path.join(directory, 'preferences.json'), JSON.stringify(preferences));
  const effects = { writes: 0, nativeThemeChanges: 0, titles: [] };
  const handlers = new Map();
  class NativeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.setZoomFactor = () => {};
    }
    async loadURL(url) { this.loadedUrl = url; }
    static fromWebContents() { return { setTitle: (title) => effects.titles.push(title) }; }
  }
  const context = vm.createContext({
    fs: fsSync,
    fsp: { ...fs, writeFile: (...args) => { effects.writes += 1; return fs.writeFile(...args); } },
    path,
    process: { env: { OPENCHAMBER_DATA_DIR: directory }, pid: process.pid, platform: 'linux', resourcesPath: directory },
    os: { homedir: () => directory },
    log: { warn() {} },
    replaceFileWithRetry,
    PRODUCT_NAME,
    PRODUCT_MARK,
    APP_VERSION: '1.24.2',
    UI_PROTOCOL: 'openchamber-ui',
    isDev,
    state: { localOrigin: 'http://127.0.0.1:57123', sidecarUrl: '', windowCounter: 1 },
    __dirname: packageDirectory,
    app: { getAppPath: () => packageDirectory },
    URL,
    performance,
    electronStartupStartedAt: 0,
    attachRendererRecovery,
    sanitizeRuntimeRequestHeaders,
    nativeTheme: { set themeSource(_value) { effects.nativeThemeChanges += 1; } },
    canUseTitleBarOverlay: () => false,
    BrowserWindow: NativeWindow,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  });
  vm.runInContext(productionSource, context, { filename: 'main.mjs', timeout: 1000 });
  const invoke = handlers.get('openchamber:invoke');
  assert.ok(handlers.has('openchamber:invoke'), 'invoke must be registered by production code');
  return {
    receiver: context.receiver,
    effects,
    directory,
    invoke: (origin, command, args) => invoke({ sender: { getURL: () => origin } }, command, args),
    close: async () => {
      await context.receiver.drain();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
};

const maliciousColor = '</style><script>globalThis.splashInjected = true</script><style>';
const maliciousSplash = Object.fromEntries(['bgLight', 'fgLight', 'bgDark', 'fgDark'].map((key) => [key, maliciousColor]));

for (const origin of [
  'openchamber-ui://app/index.html',
  'http://127.0.0.1:57123/index.html',
  'http://127.0.0.1:5173/index.html',
  'https://remote.invalid/index.html',
  'data:text/html,splash',
]) {
  test(`registered theme handler refuses ${origin} without persistence or native changes`, async () => {
    const oldSettings = { desktopHosts: [], desktopWindowState: { width: 900, height: 600 }, themeMode: 'dark' };
    const runtime = await fixture(oldSettings, {}, true);
    try {
      const before = await fs.readFile(path.join(runtime.directory, 'settings.json'), 'utf8');
      for (const args of [
        { themeMode: 'light', splash: maliciousSplash },
        { themeMode: 'dark', splash: { bgLight: '#fff', fgLight: '#000', bgDark: '#000', fgDark: '#fff' }, enabled: true },
        { themeMode: 'system' },
        {},
      ]) {
        await assert.rejects(runtime.invoke(origin, 'desktop_set_window_theme', args), /desktop_set_window_theme is disabled/);
      }
      await runtime.receiver.drain();
      assert.equal(runtime.receiver.remoteThemeAllowed, false);
      assert.equal(runtime.effects.writes, 0);
      assert.equal(runtime.effects.nativeThemeChanges, 0);
      assert.equal(await fs.readFile(path.join(runtime.directory, 'settings.json'), 'utf8'), before);
      await assert.rejects(runtime.receiver.handleInvoke(null, 'desktop_set_window_theme', {}), /Unknown desktop command/);
    } finally {
      await runtime.close();
    }
  });
}

test('startup HTML from nested and legacy persisted malicious colors equals the safe default document', async () => {
  const defaults = await fixture();
  try {
    const expected = defaults.receiver.buildStartupSplashHtml();
    for (const { settings, isDev } of [false, true].flatMap((isDev) => [
      { settings: { desktopSplashColors: maliciousSplash }, isDev },
      { settings: { splashBgLight: maliciousColor, splashBgDark: maliciousColor, splashFgLight: maliciousColor, splashFgDark: maliciousColor }, isDev },
      { settings: { desktopSplashColors: { bgLight: 'url(https://remote.invalid/beacon)', bgDark: '#123456' }, splashBgDark: maliciousColor }, isDev },
    ])) {
      const runtime = await fixture(settings, {}, isDev);
      try {
        const before = await fs.readFile(path.join(runtime.directory, 'settings.json'), 'utf8');
        const html = runtime.receiver.buildStartupSplashHtml();
        const startupWindow = runtime.receiver.createBrowserWindow({ label: 'splash-policy', restoreGeometry: false });
        assert.ok(startupWindow.loadedUrl.startsWith('data:text/html;charset=utf-8,'));
        const decodedStartupDocument = decodeURIComponent(startupWindow.loadedUrl.split(',').slice(1).join(','));
        assert.doesNotMatch(decodedStartupDocument, /<script|splashInjected|remote\.invalid|url\(/i);
        assert.equal(decodedStartupDocument, expected);
        assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);
        assert.match(html, /--splash-background: #f5f5f4;/);
        assert.match(html, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root \{\s*--splash-background: #0c0a09;/);
        assert.ok(html.includes(PRODUCT_MARK));
        assert.ok(html.includes(PRODUCT_NAME));
        assert.equal(runtime.effects.writes, 0);
        assert.equal(await fs.readFile(path.join(runtime.directory, 'settings.json'), 'utf8'), before);
      } finally {
        await runtime.close();
      }
    }
    assert.match(mainSource, /`data:text\/html;charset=utf-8,\$\{encodeURIComponent\(buildStartupSplashHtml\(\)\)\}`/);
  } finally {
    await defaults.close();
  }
});

test('normal stored light/dark/system startup choices and unrelated IPC remain available', async () => {
  const runtime = await fixture({ themeMode: 'dark' }, { version: 1, fields: { themeMode: { value: 'light', surfaces: { desktop: { value: 'system' } } } } });
  try {
    assert.equal(runtime.receiver.readThemeSource(), 'system');
    for (const themeMode of ['light', 'dark', 'system']) {
      await fs.writeFile(path.join(runtime.directory, 'preferences.json'), JSON.stringify({ version: 1, fields: { themeMode: { value: themeMode } } }));
      assert.equal(runtime.receiver.readThemeSource(), themeMode);
    }
    await fs.writeFile(path.join(runtime.directory, 'preferences.json'), '{}');
    assert.equal(runtime.receiver.readThemeSource(), 'dark', 'legacy theme mode remains readable');
    assert.equal(await runtime.invoke('https://remote.invalid', 'desktop_get_app_version'), '1.24.2');
    assert.equal(await runtime.invoke('openchamber-ui://app/index.html', 'desktop_set_window_title', { title: PRODUCT_NAME }), null);
    assert.equal(await runtime.invoke('https://remote.invalid', 'desktop_set_window_title', { title: PRODUCT_NAME }), null);
    assert.deepEqual(runtime.effects.titles, [PRODUCT_NAME, PRODUCT_NAME]);
    await assert.rejects(runtime.invoke('https://remote.invalid', 'desktop_pick_theme_file'), /IPC not available for this origin/);
    for (const url of ['http://127.0.0.1:5173/index.html', 'openchamber-ui://app/index.html']) {
      const window = runtime.receiver.createBrowserWindow({ label: 'splash-policy', restoreGeometry: false, url });
      assert.equal(window.loadedUrl, url, 'normal application navigation must not load the splash');
      assert.equal(window.options.title, PRODUCT_NAME);
      assert.equal(window.options.webPreferences.contextIsolation, true);
      assert.equal(window.options.webPreferences.nodeIntegration, false);
    }
    assert.equal(runtime.effects.writes, 0);
  } finally {
    await runtime.close();
  }
});
