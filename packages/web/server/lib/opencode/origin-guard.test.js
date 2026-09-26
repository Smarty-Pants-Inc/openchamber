import assert from 'node:assert/strict';
import { test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createBootstrapRuntime } from './bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';

// smarty-code#391: in the passwordless loopback mode (no human auth, no UI password), any page in the same browser, a
// sandboxed preview among them, could POST to the application's mutations. A browser's mutation now needs this server's
// own origin or a native client's; requests no browser sent, and every GET, are unchanged.
test('passwordless loopback: browser mutations need the application origin; native clients and GETs pass', async () => {
  let shutdowns = 0;
  const app = express();
  app.use((req, res, next) => { // As server/index.js: its CORS policy admits the packaged desktop client's origin.
    if (req.headers.origin === 'openchamber-ui://app') res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    next();
  });
  const tunnel = { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() };
  createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes, registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes, registerTtsRoutes: () => {}, registerNotificationRoutes: () => {}, registerOpenChamberRoutes: () => {},
  }).setupBaseRoutes(app, { tunnelAuthController: tunnel, process, runtimeName: 'test', openchamberVersion: 'fixture',
    sessionRuntime: {}, gracefulShutdown: async () => { shutdowns++; }, getHealthSnapshot: () => ({}) });
  const writes = [];
  app.post('/api/fs/write', (req, res) => { writes.push(req.body); res.json({ ok: true }); });
  const form = (origin, site) => {
    const call = request(app).post('/api/fs/write').type('form').send({ path: '/tmp/x', content: 'changed' });
    if (origin !== undefined) call.set('Origin', origin);
    if (site !== undefined) call.set('Sec-Fetch-Site', site);
    return call;
  };
  await form('null', 'cross-site').expect(403); // A sandboxed (opaque) page.
  await form('https://attacker.test', 'cross-site').expect(403); // Another site.
  await form(undefined, 'cross-site').expect(403); // A browser that sent no Origin.
  await request(app).post('/api/system/shutdown').set('Origin', 'null').expect(403);
  assert.deepEqual(writes, []); assert.equal(shutdowns, 0);
  await form(undefined, 'same-origin').expect(200); // The application's own page.
  const self = request(app).post('/api/fs/write'); // Origin equal to the server's own (browsers without Sec-Fetch-Site).
  await self.set('Origin', new URL(self.url).origin).type('form').send({ path: '/tmp/x', content: 'self' }).expect(200);
  await form('openchamber-ui://app').expect(200); // The packaged desktop client.
  await form('vscode-webview://abc123').expect(200); // The VS Code webview.
  await form().expect(200); // No browser: a CLI or native bridge.
  assert.equal(writes.length, 5);
  await request(app).get('/api/system/info').set('Origin', 'null').expect((res) => assert.notEqual(res.status, 403));
});
