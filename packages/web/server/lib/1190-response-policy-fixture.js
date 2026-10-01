import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth } from './ui-auth/human-auth.js';
import { createStaticRoutesRuntime } from './opencode/static-routes-runtime.js';
import { registerPreviewServeRoute, mintPreviewCapability } from './fs/preview-capability.js';
import { registerFsRoutes } from './fs/routes.js';
import { createResponsePolicyMiddleware } from './http-response-policy.js';

export async function fixture(responsePolicy, resolveSession, beforePolicy) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'policy1190-')));
  const html = '<!doctype html><script src="https://policy-fixture.invalid/inert.js"></script>';
  fs.writeFileSync(path.join(directory, 'index.html'), html);
  fs.writeFileSync(path.join(directory, 'raw.txt'), 'inert raw file');
  fs.writeFileSync(path.join(directory, 'sw.js'), '/* inert worker */');
  fs.mkdirSync(path.join(directory, 'assets'));
  fs.writeFileSync(path.join(directory, 'assets/inert.js'), '/* inert asset */');
  const app = express();
  let response, downstream = 0;
  const responses = [];
  app.use((req, res, next) => { response = res; responses.push(res); beforePolicy?.(req, res); next(); });
  const middleware = createResponsePolicyMiddleware(responsePolicy, resolveSession ? { resolve: resolveSession } : null);
  if (middleware) app.use(middleware);
  app.use((_req, _res, next) => { downstream++; next(); });
  registerPreviewServeRoute(app);
  registerFsRoutes(app, {
    fs, fsPromises: fs.promises, path, os,
    openchamberUserConfigRoot: path.join(directory, 'config'), managedChatsRoot: path.join(directory, 'chats'),
    resolveProjectDirectory: async () => ({ directory }), normalizeDirectoryPath: value => value,
  });
  const upstream = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('[]'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  createStaticRoutesRuntime({ fs, path, express, __dirname: directory,
    process: { env: { OPENCHAMBER_DIST_DIR: directory } },
    resolveProjectDirectory: async () => ({ directory }),
    buildOpenCodeUrl: route => `http://127.0.0.1:${upstream.address().port}${route}`,
    getOpenCodeAuthHeaders: () => ({}), readSettingsFromDiskMigrated: async () => ({}),
    normalizePwaAppName: (value, fallback) => value || fallback,
    normalizePwaOrientation: (value, fallback) => value || fallback,
  }).registerStaticRoutes(app);
  // All owning factories are registered before the real listener starts.
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = (route = '/', headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { Connection: 'close', ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(7000, () => req.destroy(new Error('Fixture request deadline')));
    req.on('error', reject); req.end();
  });
  return { app, server, call, html, directory, middleware,
    preview: `/api/fs/preview/${mintPreviewCapability(directory)}/index.html`,
    response: () => response, responses: () => responses, downstream: () => downstream,
    async close() {
      server.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function humanFixture() {
  const database = new DatabaseSync(':memory:');
  const human = await createHumanAuth({ database, baseURL: 'https://code.smartypants.ai',
    secret: 'private-fixture-only-thirty-two-character-secret', googleClientId: 'fixture-client',
    googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] });
  (await human.auth.$context).options.session.disableSessionRefresh = true;
  const seed = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await seed.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ email: 'fixture@example.test', emailVerified: true }));
  const headers = Object.fromEntries(await helpers.getAuthHeaders({ userId: user.id }));
  const session = (await human.resolve({ headers })).session;
  return { human, database, headers, session, adapter: (await human.auth.$context).internalAdapter,
    close: () => { human.dispose(); database.close(); } };
}
