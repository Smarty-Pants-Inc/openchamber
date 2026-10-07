// Real-Electron probe for openchamber#554 round 6: a browser panel inside a window
// that shows a remote host must never reach this machine's loopback.
//
// Run: xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/remote-loopback-probe.mjs <non-loopback IPv4 of this host>
// (from packages/electron). It prints REMOTE_LOOPBACK_RECEIPT=<json> and exits 0.
//
// The panel session gets the same onBeforeRequest rule main.mjs installs, with
// isLocalSender replaced by "the window shows the local-app origin". A loopback
// sentinel server counts every request that reaches it.
import http from 'node:http';
import { app, BrowserWindow, session } from 'electron';
import { shouldBlockBrowserPanelRequest } from '../browser-panel-security.mjs';

const remoteIp = process.argv.at(-1);
const PARTITION = 'persist:openchamber-browser-probe';
const listen = (server, host) => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));

const main = async () => {
const sentinelHits = [];
const sentinel = http.createServer((req, res) => {
  sentinelHits.push(req.url);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end('<title>LOCAL_SENTINEL</title>LOCAL_SENTINEL');
});
const sentinelPort = await listen(sentinel, '127.0.0.1');
const loopback = (tag) => `http://127.0.0.1:${sentinelPort}/${tag}`;

// One page server bound to every address: the embedder page and the remote test pages.
const pages = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/embed.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<webview id="v" partition="${PARTITION}" src="${url.searchParams.get('src')}" allowpopups></webview>`);
  }
  if (url.pathname === '/redirect') {
    res.writeHead(302, { Location: loopback('redirect') });
    return res.end();
  }
  if (url.pathname === '/page') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<title>REMOTE_PAGE</title>REMOTE_PAGE');
  }
  res.statusCode = 404;
  res.end();
});
const pagesPort = await listen(pages, '0.0.0.0');
const remoteOrigin = `http://${remoteIp}:${pagesPort}`;
const localOrigin = `http://127.0.0.1:${pagesPort}`;

const isLocalSender = (contents) => {
  try { return new URL(contents.getURL()).origin === localOrigin; } catch { return false; }
};
const embedderIsLocal = (contents) => {
  if (contents && !contents.isDestroyed()) {
    const host = contents.hostWebContents;
    return Boolean(host && !host.isDestroyed() && isLocalSender(host));
  }
  return BrowserWindow.getAllWindows().every((window) => window.isDestroyed() || isLocalSender(window.webContents));
};
// PROBE_WITHOUT_RULE=1 is the negative control: the same steps with no rule.
if (process.env.PROBE_WITHOUT_RULE !== '1') session.fromPartition(PARTITION).webRequest.onBeforeRequest((details, callback) => {
  callback({ cancel: shouldBlockBrowserPanelRequest({ url: details.url, embedderIsLocal: embedderIsLocal(details.webContents) }) });
});
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  // As main.mjs: popups load in place.
  contents.setWindowOpenHandler(({ url }) => { void contents.loadURL(url).catch(() => {}); return { action: 'deny' }; });
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const openPanel = async (origin, src) => {
  const window = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
  const attached = new Promise((resolve) => window.webContents.once('did-attach-webview', (_event, contents) => resolve(contents)));
  // The embedder's own load can report ERR_FAILED once its webview takes over; the attach is what matters.
  window.loadURL(`${origin}/embed.html?src=${encodeURIComponent(src)}`).catch(() => {});
  const view = await attached;
  await settle(800);
  return { window, view };
};
const title = (view) => { try { return view.getTitle(); } catch { return 'destroyed'; } };

const rows = [];
const step = async (label, run) => {
  const before = sentinelHits.length;
  const outcome = await run().catch((error) => ({ error: String(error?.code || error?.message || error) }));
  await settle(800);
  rows.push({ label, sentinelHits: sentinelHits.length - before, ...outcome });
};

// Remote window: every path to loopback.
const remote = await openPanel(remoteOrigin, loopback('restored'));
rows.push({ label: 'remote: restored URL', sentinelHits: sentinelHits.filter((url) => url === '/restored').length, title: title(remote.view) });
await step('remote: embedder loadURL', async () => { await remote.view.loadURL(loopback('navigate')).catch(() => {}); return { title: title(remote.view) }; });
await step('remote: localhost spelling', async () => { await remote.view.loadURL(`http://localhost:${sentinelPort}/spelling`).catch(() => {}); return { title: title(remote.view) }; });
await step('remote: control page loads', async () => { await remote.view.loadURL(`${remoteOrigin}/page`); return { title: title(remote.view) }; });
await step('remote: redirect hop', async () => { await remote.view.loadURL(`${remoteOrigin}/redirect`).catch(() => {}); return { title: title(remote.view) }; });
await remote.view.loadURL(`${remoteOrigin}/page`);
await step('remote: page fetch', async () => ({ result: await remote.view.executeJavaScript(`fetch(${JSON.stringify(loopback('fetch'))}).then(r => r.text()).catch(e => 'blocked:' + e.message)`) }));
await step('remote: page navigation', async () => { await remote.view.executeJavaScript(`location.href = ${JSON.stringify(loopback('location'))}`); await settle(500); return { title: title(remote.view) }; });
await step('remote: popup', async () => { await remote.view.executeJavaScript(`window.open(${JSON.stringify(loopback('popup'))}); 1`, true); await settle(500); return { title: title(remote.view) }; });
await step('remote: iframe', async () => ({ result: await remote.view.executeJavaScript(`new Promise(r => { const f = document.createElement('iframe'); f.src = ${JSON.stringify(loopback('iframe'))}; f.onload = () => r('loaded'); document.body.append(f); setTimeout(() => r('timeout'), 1500); })`) }));
remote.window.destroy();

// Local window: the same loopback page still opens (the user's own dev server).
const local = await openPanel(localOrigin, loopback('local-restored'));
rows.push({ label: 'local: restored URL', sentinelHits: sentinelHits.filter((url) => url === '/local-restored').length, title: title(local.view) });
await step('local: embedder loadURL', async () => { await local.view.loadURL(loopback('local-navigate')); return { title: title(local.view) }; });
local.window.destroy();

console.log('REMOTE_LOOPBACK_RECEIPT=' + JSON.stringify({ remoteOrigin, sentinelPort, rows, sentinelHits }));
sentinel.close();
pages.close();
app.exit(0);
};

// Electron's ready event cannot fire while the ESM entry is still awaiting at top level.
// Keep running between the remote and local windows.
app.on('window-all-closed', () => {});
app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1); });
