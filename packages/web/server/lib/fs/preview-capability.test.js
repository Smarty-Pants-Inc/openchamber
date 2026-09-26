import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintPreviewCapability, PREVIEW_CSP, readPreviewCapability, registerPreviewServeRoute } from './preview-capability.js';
import { registerFsRoutes } from './routes.js';

// smarty-code#382: an HTML preview runs sandboxed through a capability that reads only its own directory.
describe('HTML preview capability', () => {
  let root, site, other;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-preview-')));
    site = path.join(root, 'site'); other = path.join(root, 'other');
    await fs.mkdir(path.join(site, 'js'), { recursive: true }); await fs.mkdir(other);
    await fs.writeFile(path.join(site, 'index.html'), '<script src="js/app.js"></script>');
    await fs.writeFile(path.join(site, 'js', 'app.js'), 'window.ok = 1;');
    await fs.writeFile(path.join(other, 'secret.txt'), 'not yours');
    await fs.writeFile(path.join(root, 'beside.txt'), 'not yours either');
    await fs.symlink(other, path.join(site, 'link'));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const app = () => { const server = express(); registerPreviewServeRoute(server); return server; };

  it('grants its directory until it expires, and nothing when altered', () => {
    const now = 1_000;
    const capability = mintPreviewCapability(site, now);
    expect(readPreviewCapability(capability, now + 1)).toBe(site);
    expect(readPreviewCapability(capability, now + 9 * 60 * 60 * 1000)).toBeNull();
    const [payload, signature] = capability.split('.');
    const forged = Buffer.from(JSON.stringify({ d: '/', e: now + 1e9 })).toString('base64url');
    for (const bad of [`${forged}.${signature}`, `${payload}.${signature}x`, payload, `${capability}.x`, '', 'a.b']) {
      expect(readPreviewCapability(bad, now + 1)).toBeNull();
    }
  });

  it('serves the page and its own files as a sandboxed document, without cookies or the user session', async () => {
    const base = `/api/fs/preview/${mintPreviewCapability(site)}`;
    const page = await request(app()).get(`${base}/index.html`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toBe(PREVIEW_CSP);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['set-cookie']).toBeUndefined();
    const script = await request(app()).get(`${base}/js/app.js`);
    expect(script.status).toBe(200);
    expect(script.text).toBe('window.ok = 1;');
  });

  it('reads nothing outside the granted directory: not by .., a symbolic link, another directory or a bad capability', async () => {
    const base = `/api/fs/preview/${mintPreviewCapability(site)}`;
    for (const target of [`${base}/..%2Fbeside.txt`, `${base}/js/..%2F..%2Fbeside.txt`, `${base}/link/secret.txt`,
      `${base}/js`, `/api/fs/preview/${mintPreviewCapability(other)}/..%2Fsite%2Findex.html`,
      '/api/fs/preview/not-a-capability/index.html']) {
      const response = await request(app()).get(target);
      expect(response.status).toBe(404);
      expect(response.text).toBe('Not found');
    }
  });

  it('serves beneath a filesystem-root capability, refuses a FIFO without waiting, and refuses a file swapped after the check', async () => {
    const underRoot = await request(app()).get(`/api/fs/preview/${mintPreviewCapability('/')}/${encodeURIComponent(path.join(site, 'index.html').slice(1))}`);
    expect(underRoot.status).toBe(200);
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [path.join(site, 'pipe.html')]);
    const fifo = await request(app()).get(`/api/fs/preview/${mintPreviewCapability(site)}/pipe.html`).timeout(3000);
    expect(fifo.status).toBe(404);
    // The opened file is outside; the canonical path checked afterwards names an inside file (a swap in between).
    const realpath = vi.spyOn(fs, 'realpath').mockResolvedValueOnce(path.join(site, 'index.html'));
    try {
      const swapped = await request(app()).get(`/api/fs/preview/${mintPreviewCapability(site)}/..%2Fbeside.txt`);
      expect(swapped.status).toBe(404);
      expect(realpath).toHaveBeenCalled();
    } finally { realpath.mockRestore(); }
  });

  it('never lets a raw file run scripts when opened as a document, except a real PDF', async () => {
    await fs.writeFile(path.join(site, 'doc.pdf'), '%PDF-1.4');
    await fs.writeFile(path.join(site, 'img.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await fs.symlink(path.join(site, 'img.svg'), path.join(site, 'fake.pdf'));
    const routes = new Map();
    registerFsRoutes({ get: (p, h) => routes.set(p, h), post: () => {} }, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: site }),
      resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, 'config'),
    });
    const raw = async (name) => {
      const headers = {};
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; },
        setHeader(key, value) { headers[key.toLowerCase()] = value; }, type(value) { headers['content-type'] = value; return this; },
        send() { return this; } };
      await routes.get('/api/fs/raw')({ query: { path: path.join(site, name) }, get: () => null, headers: {} }, res);
      return { status: res.statusCode, headers };
    };
    for (const name of ['img.svg', 'index.html', 'fake.pdf']) {
      const served = await raw(name);
      expect(served.status).toBe(200);
      expect(served.headers['content-security-policy']).toBe('sandbox');
    }
    const pdf = await raw('doc.pdf');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-security-policy']).toBeUndefined();
  });

  it('is granted only through the workspace rules, for a file, as a URL to that file in its own directory', async () => {
    const routes = new Map();
    registerFsRoutes({ get: () => {}, post: (p, h) => routes.set(p, h) }, {
      os: { homedir: () => root }, path, fsPromises: fs, spawn: vi.fn(), crypto: { randomUUID: () => 'id-0' },
      normalizeDirectoryPath: (p) => p, resolveProjectDirectory: async () => ({ directory: site }),
      resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: path.join(root, 'config'),
    });
    const grant = async (body) => {
      const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }, setHeader() {} };
      await routes.get('/api/fs/preview')({ body, query: {}, get: () => null, headers: {} }, res);
      return res;
    };
    const granted = await grant({ path: path.join(site, 'index.html') });
    expect(granted.statusCode).toBe(200);
    const [, capability, file] = granted.body.url.match(/^\/api\/fs\/preview\/([^/]+)\/([^/]+)$/);
    expect(readPreviewCapability(capability)).toBe(site);
    expect(file).toBe('index.html');
    expect((await grant({})).statusCode).toBe(400);
    const outside = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }, setHeader() {} };
    await routes.get('/api/fs/preview')({ body: { path: path.join(site, 'index.html') }, query: { allowOutsideWorkspace: 'true' },
      get: () => null, headers: {} }, outside);
    expect(outside.statusCode).toBe(403);
    expect((await grant({ path: path.join(site, 'js') })).statusCode).toBe(400);
  });
});
