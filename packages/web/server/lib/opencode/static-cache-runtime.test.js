import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import compression from 'compression';
import request from 'supertest';
import { createStaticRoutesRuntime } from './static-routes-runtime.js';

const html = (version) => `<!doctype html><link rel="stylesheet" href="/assets/index-${version}.css"><script src="/assets/index-${version}.js"></script>${' '.repeat(2048)}`;
let directory;
let oldDist;
let currentDist;
let server;
let handler;
let currentApp;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-cache-'));
  // Installed releases have a hidden ancestor; it is not a requested dotfile.
  oldDist = path.join(directory, '.local', 'old');
  currentDist = path.join(directory, '.local', 'new');
  for (const [version, dist] of [['old', oldDist], ['new', currentDist]]) {
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    for (const file of ['index.html', 'mobile.html', 'mini-chat.html', 'sw.js']) {
      fs.writeFileSync(path.join(dist, file), file === 'sw.js' ? `/* ${version} worker */` : html(version));
      fs.utimesSync(path.join(dist, file), 0, 0);
    }
    fs.writeFileSync(path.join(dist, 'assets', `index-${version}.js`), `/* ${version} script */`);
    fs.writeFileSync(path.join(dist, 'assets', `index-${version}.css`), `/* ${version} style */`);
    fs.writeFileSync(path.join(dist, '.private.js'), 'must not be served');
  }
  currentApp = express();
  currentApp.use(compression());
  createStaticRoutesRuntime({
    fs, path, process: { env: { OPENCHAMBER_DIST_DIR: currentDist } },
    __dirname: '/unused', express,
    resolveProjectDirectory: () => '', buildOpenCodeUrl: () => '',
    getOpenCodeAuthHeaders: () => ({}), readSettingsFromDiskMigrated: async () => ({}),
    normalizePwaAppName: (value) => value, normalizePwaOrientation: (value) => value,
  }).registerStaticRoutes(currentApp);
  handler = currentApp;
  server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

const expectCurrentHtml = (response, body = true) => {
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.headers['last-modified']).toBeUndefined();
  expect(response.headers.etag).toBeUndefined();
  expect(response.headers['content-type']).toContain('text/html');
  if (body) expect(response.text).toBe(html('new'));
};

describe('release HTML cache revalidation over HTTP', () => {
  it('replaces a returning client cache after promotion despite identical size and epoch mtime', async () => {
    const legacy = express();
    legacy.use(express.static(oldDist));
    handler = legacy;
    const cached = await request(server).get('/');
    expect(cached.text).toBe(html('old'));
    expect(cached.headers['last-modified']).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cached.headers.etag).toBeTruthy();
    handler = currentApp;

    // Keep the same origin and cached response; perform actual conditional HTTP requests.
    for (const headers of [
      { 'If-Modified-Since': cached.headers['last-modified'] },
      { 'If-Modified-Since': 'Sun, 13 Sep 2026 00:00:00 GMT' },
      { 'If-None-Match': cached.headers.etag },
      { 'If-None-Match': cached.headers.etag, 'If-Modified-Since': cached.headers['last-modified'] },
    ]) {
      const refreshed = await request(server).get('/').set(headers);
      expectCurrentHtml(refreshed);
      for (const [, asset] of refreshed.text.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const response = await request(server).get(asset);
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain(asset.endsWith('.css') ? 'text/css' : 'javascript');
        expect(response.text).toBe(fs.readFileSync(path.join(currentDist, asset), 'utf8'));
      }
    }
  });

  it('serves all entrypoints and SPA deep links without stale validators, including wildcard conditions', async () => {
    for (const route of ['/', '/index.html', '/mobile.html', '/mini-chat.html', '/sessions/abc']) {
      expectCurrentHtml(await request(server).get(route));
      for (const condition of [{ 'If-None-Match': '*' }, { 'If-Modified-Since': 'Sun, 13 Sep 2026 00:00:00 GMT' }]) {
        expectCurrentHtml(await request(server).get(`${route}?returning=1`).set(condition));
      }
      expectCurrentHtml(await request(server).head(route).set('If-None-Match', '*'), false);
    }
  });

  it('keeps compressed HTML current and does not serve partial bootstrap documents', async () => {
    const compressed = await request(server).get('/').set('Accept-Encoding', 'gzip');
    expectCurrentHtml(compressed);
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expectCurrentHtml(await request(server).get('/').set('Range', 'bytes=0-10'));
  });

  it('delivers service worker updates with no-store and no false conditional 304', async () => {
    for (const headers of [{ 'If-None-Match': '*' }, { 'If-Modified-Since': 'Sun, 13 Sep 2026 00:00:00 GMT' }]) {
      const response = await request(server).get('/sw.js').set(headers);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['content-type']).toContain('javascript');
      expect(response.headers['last-modified']).toBeUndefined();
      expect(response.headers.etag).toBeUndefined();
      expect(response.text).toBe('/* new worker */');
    }
  });

  it('preserves successful asset MIME, bytes, and ordinary conditional caching', async () => {
    for (const extension of ['js', 'css']) {
      const url = `/assets/index-new.${extension}`;
      const response = await request(server).get(url);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain(extension === 'css' ? 'text/css' : 'javascript');
      expect(response.headers.etag).toBeTruthy();
      expect((await request(server).get(url).set('If-None-Match', response.headers.etag)).status).toBe(304);
    }
  });

  it('leaves parent API validators and conditional headers intact', async () => {
    currentApp.get('/api/cache-proof', (req, res) => res.json({ condition: req.headers['if-match'] }));
    const response = await request(server).get('/api/cache-proof').set('If-Match', '"api-revision"');
    expect(response.body).toEqual({ condition: '"api-revision"' });
    expect(response.headers.etag).toBeTruthy();
    expect((await request(server).get('/api/cache-proof')
      .set('If-Match', '"api-revision"').set('If-None-Match', response.headers.etag)).status).toBe(304);
  });

  it('returns non-cacheable non-HTML 404s for missing or hidden assets instead of the SPA', async () => {
    for (const url of ['/assets/index-old.js', '/assets/index-old.css', '/assets/missing.wasm', '/assets/missing', '/missing.js', '/missing.css', '/.private.js']) {
      const response = await request(server).get(url);
      expect(response.status).toBe(404);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).not.toContain('<!doctype');
    }
  });
});
