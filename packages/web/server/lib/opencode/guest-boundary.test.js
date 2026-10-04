import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth } from '../ui-auth/human-auth.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { listInstalledGuests } from '../guests/catalog.js';
import { onExtensionStoreWrite } from '../guests/persist.js';
import { createFsSearchRuntime } from '../fs/search.js';
import { createBootstrapRuntime } from './bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';

const baseURL = 'https://code.smartypants.ai';
const guestId = 'approved-guest';
const granted = ['files', 'model', 'filesystem', 'network', 'service'];
afterEach(() => vi.restoreAllMocks());

async function fixture(humanMode = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-guest-boundary-')));
  const guestRoot = path.join(root, 'package');
  const builtInRoot = path.join(root, 'built-ins');
  fs.mkdirSync(guestRoot);
  fs.mkdirSync(builtInRoot);
  const manifest = { name: '@fixture/guest', version: '1.0.0', openchamber: { apiVersion: 1, contributes: {
    panel: { id: guestId, name: 'Approved guest', icon: 'window', entry: 'index.html' },
    capabilities: ['files', 'model'], filesystem: ['/fixture/narrow/**'],
    integration: { name: 'Fixture', description: 'Fixture integration', oauth: { apiOrigin: 'https://api.example.test',
      authorizeUrl: 'https://login.example.test/authorize', tokenUrl: 'https://login.example.test/token' } },
    service: { entry: 'service.js', runtime: 'host', permissions: { exec: ['fixture-command'] } },
  } } };
  const packagePath = path.join(guestRoot, 'package.json');
  fs.writeFileSync(packagePath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(guestRoot, 'index.html'), '<script src="./main.js"></script>');
  fs.writeFileSync(path.join(guestRoot, 'main.js'), 'globalThis.fixtureGuest = true;');
  fs.writeFileSync(path.join(guestRoot, 'service.js'), 'throw new Error("disabled guest must never spawn");');
  fs.writeFileSync(path.join(builtInRoot, 'registry.json'), JSON.stringify({ version: 1,
    extensions: [{ id: 'openchamber-builtin-fixture', directory: 'fixture' }] }));
  const storePath = path.join(root, 'extensions.json');
  fs.writeFileSync(storePath, JSON.stringify({ paths: [guestRoot], capabilityGrants: { [guestId]: granted },
    capabilityScopes: { [guestId]: { filesystem: ['/fixture/narrow/**'], apiOrigin: 'https://api.example.test',
      oauth: { authorizeUrl: 'https://login.example.test/authorize', tokenUrl: 'https://login.example.test/token' },
      service: { exec: ['fixture-command'], sockets: [] } } } }));
  fs.writeFileSync(path.join(root, 'guest-auth.json'), '{"fixture-preserved":true}');
  fs.mkdirSync(path.join(root, 'guest-storage'));
  const storagePath = path.join(root, 'guest-storage', `${guestId}.json`);
  fs.writeFileSync(storagePath, '{"fixture-preserved":true}');
  // Establish a real installed, enabled, approved descriptor, not an empty-install control.
  const [guest] = await listInstalledGuests({ persistPath: storePath });
  assert.ok(guest, 'Fixture must be installed through the real catalog');
  assert.equal(guest.id, guestId);
  assert.deepEqual(new Set(guest.capabilityGrants), new Set(granted));
  assert.equal(guest.enabled, true);

  const database = new DatabaseSync(':memory:');
  const human = humanMode ? await createHumanAuth({ database, baseURL,
    secret: 'fixture-only-secret-at-least-thirty-two-characters', googleClientId: 'fixture-client',
    googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] }) : null;
  let cookie;
  if (human) {
    const seed = betterAuth({ ...human.auth.options,
      user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helpers = (await seed.$context).test;
    const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
    cookie = (await helpers.getAuthHeaders({ userId: user.id })).get('cookie');
  }
  const oldJwtSecret = process.env.OPENCODE_JWT_SECRET;
  if (!humanMode) process.env.OPENCODE_JWT_SECRET = 'fixture-only-jwt-secret-not-a-live-credential';
  const app = express();
  const { uiAuthController } = createBootstrapRuntime({ express, createUiAuth, registerServerStatusRoutes,
    registerCommonRequestMiddleware, registerAuthAndAccessRoutes, registerTtsRoutes: () => {},
    registerNotificationRoutes: () => {}, registerOpenChamberRoutes: () => {},
  }).setupBaseRoutes(app, { humanAuth: human, uiPassword: humanMode ? undefined : 'fixture-password',
    process: { env: { OPENCHAMBER_ALLOWED_HOSTS: 'code.smartypants.ai' }, pid: process.pid },
    runtimeName: 'fixture', openchamberVersion: '1.24.2', sessionRuntime: {}, getHealthSnapshot: () => ({}),
    readSettingsFromDiskMigrated: async () => ({}),
    tunnelAuthController: { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() } });

  let releaseQueued = () => {}, noteQueued = () => {};
  const queued = new Promise((resolve) => { noteQueued = resolve; });
  // Hold at ingress: the disabled composition must never reach a catalog read,
  // even when withdrawal completes while an earlier service request is queued.
  app.use((req, _res, next) => {
    if (req.get('x-fixture-queue') !== 'hold') return next();
    releaseQueued = next;
    noteQueued();
  });
  const effects = { reads: 0, writes: 0, storeWrites: 0, streams: 0, network: 0, spawn: 0, proxy: [] };
  const readFile = fsPromises.readFile.bind(fsPromises);
  const readFileSync = fs.readFileSync.bind(fs);
  const writeFile = fsPromises.writeFile.bind(fsPromises);
  const tracks = (file) => String(file).startsWith(`${root}${path.sep}`);
  const spies = [
    vi.spyOn(fsPromises, 'readFile').mockImplementation((file, ...args) => {
      if (tracks(file)) effects.reads++;
      return readFile(file, ...args);
    }),
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (tracks(file)) effects.reads++;
      return readFileSync(file, ...args);
    }),
    vi.spyOn(fsPromises, 'writeFile').mockImplementation((file, ...args) => {
      if (tracks(file)) effects.writes++;
      return writeFile(file, ...args);
    }),
    vi.spyOn(fs, 'createReadStream').mockImplementation(() => { effects.streams++; throw new Error('Unexpected asset stream'); }),
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => { effects.network++; throw new Error('Unexpected outbound fetch'); }),
    vi.spyOn(childProcess, 'spawn').mockImplementation(() => { effects.spawn++; throw new Error('Unexpected child process'); }),
  ];
  const unsubscribe = onExtensionStoreWrite(() => { effects.storeWrites++; });
  const close = () => {
    releaseQueued(); unsubscribe(); spies.forEach((spy) => spy.mockRestore());
    uiAuthController.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true });
    if (oldJwtSecret === undefined) delete process.env.OPENCODE_JWT_SECRET;
    else process.env.OPENCODE_JWT_SECRET = oldJwtSecret;
  };
  try {
    const { createFeatureRoutesRuntime } = await import('./feature-routes-runtime.js');
    await createFeatureRoutesRuntime({ clientReloadDelayMs: 0 }).registerRoutes(app, {
      crypto, fs, fsPromises, os, path, createFsSearchRuntime, spawn: childProcess.spawn, openchamberDataDir: root,
      openchamberUserConfigRoot: path.join(root, 'config'), builtInExtensionsDir: builtInRoot,
      openchamberVersion: '1.24.2', resolveGitBinaryForSpawn: () => 'git',
      resolveProjectDirectory: async () => ({ directory: root }),
      resolveOptionalProjectDirectory: async () => ({ directory: null }),
      readSettingsFromDisk: async () => ({}), readSettingsFromDiskMigrated: async () => ({}),
      sanitizeProjects: () => [], getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (route) => `http://127.0.0.1:9${route}`,
      getOpenChamberEventClients: () => new Set(),
    });
  } catch (error) { close(); throw error; }
  // Downstream generic proxy sentinel, registered only after the actual feature composition.
  app.use('/api', (req, res) => {
    effects.proxy.push({ method: req.method, path: req.originalUrl });
    if (req.path === '/global/event') return res.type('text/event-stream').send('data: {"type":"fixture"}\n\n');
    return res.json({ forwarded: true });
  });
  app.get('/assets/first-party.js', (_req, res) => res.type('application/javascript').send('firstParty();'));
  const call = (method, route, authenticated = true) => {
    const req = request(app)[method](route).set('Host', 'code.smartypants.ai');
    if (authenticated && cookie) req.set('Cookie', cookie);
    if (!['get', 'head', 'options'].includes(method)) req.set('Origin', baseURL);
    return req;
  };
  const protectedPaths = [packagePath, storePath, path.join(root, 'guest-auth.json'), storagePath,
    path.join(guestRoot, 'index.html'), path.join(guestRoot, 'main.js'), path.join(guestRoot, 'service.js')];
  const before = protectedPaths.map((file) => readFileSync(file));
  return { app, call, effects, queued, releaseQueued: () => releaseQueued(), manifest,
    changeManifest: async () => {
      const bytes = JSON.stringify(manifest);
      await writeFile(packagePath, bytes);
      before[0] = Buffer.from(bytes);
    },
    assertNoEffects: () => {
      assert.deepEqual(effects, { reads: 0, writes: 0, storeWrites: 0, streams: 0, network: 0, spawn: 0, proxy: [] });
      protectedPaths.forEach((file, i) => assert.deepEqual(readFileSync(file), before[i]));
    },
    close,

  };
}

const disabled = (res) => {
  assert.equal(res.status, 501);
  if (res.req.method !== 'HEAD') assert.deepEqual(res.body, { error: 'guests-disabled' });
};

test('actual feature composition denies every guest method and operation without host effects', async () => {
  const f = await fixture();
  try {
    for (const route of ['/api/guests', '/api/guests/', `/api/guests/${guestId}/index.html`,
      `/api/guests/${guestId}/main.js`, '/api/guests/openchamber-builtin-fixture/index.html']) {
      for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete', 'options']) {
        await f.call(method, route).expect(disabled);
      }
    }
    const operations = [
      ['post', '/api/guests'], ['post', '/api/guests/upload'], ['put', '/api/guests/upload'],
      ['post', '/api/guests/updates/check'], ['post', `/api/guests/${guestId}/update`],
      ['put', `/api/guests/${guestId}/capabilities`], ['put', `/api/guests/${guestId}/enabled`],
      ['put', `/api/guests/${guestId}/service/sockets`], ['post', `/api/guests/${guestId}/service/request`],
      ['get', `/api/guests/${guestId}/service/status`], ['post', `/api/guests/${guestId}/request`],
      ['post', `/api/guests/${guestId}/files`], ['post', `/api/guests/${guestId}/generate`],
      ['post', `/api/guests/${guestId}/storage`], ['put', `/api/guests/${guestId}/token`],
      ['put', `/api/guests/${guestId}/settings`], ['put', `/api/guests/${guestId}/oauth/client`],
      ['post', `/api/guests/${guestId}/oauth/start`], ['get', `/api/guests/${guestId}/oauth/status`],
      ['get', `/api/guests/${guestId}/oauth/callback?code=fixture&state=fixture`],
      ['get', `/api/guests/${guestId}/oauth/callback?error=access_denied&state=wrong`],
      ['delete', `/api/guests/${guestId}/oauth`], ['delete', `/api/guests/${guestId}`],
    ];
    for (const [method, route] of operations) {
      const req = f.call(method, route);
      if (method === 'post' || method === 'put') {
        if (route.endsWith('/upload')) req.type('application/octet-stream').send(Buffer.from('fixture archive'));
        else req.send({ granted, enabled: true, method: 'POST', path: '/fixture', op: 'write', content: 'changed' });
      }
      await req.expect(disabled);
    }
    f.assertNoEffects();
  } finally { f.close(); }
});

test('stale approval and a queued service crossing withdrawal remain terminal, with stored state unchanged', async () => {
  const f = await fixture();
  try {
    f.manifest.openchamber.contributes.filesystem = ['/fixture/wide/**'];
    f.manifest.openchamber.contributes.integration.oauth.tokenUrl = 'https://changed.example.test/token';
    f.manifest.openchamber.contributes.service.permissions.exec = ['changed-command'];
    await f.changeManifest();
    await f.call('put', `/api/guests/${guestId}/capabilities`).send({ granted }).expect(disabled);
    const service = f.call('post', `/api/guests/${guestId}/service/request`).set('x-fixture-queue', 'hold')
      .send({ method: 'POST', path: '/run' }).then(disabled);
    await f.queued;
    await f.call('put', `/api/guests/${guestId}/capabilities`).send({ granted: [] }).expect(disabled);
    await f.call('put', `/api/guests/${guestId}/enabled`).send({ enabled: false }).expect(disabled);
    await f.call('delete', `/api/guests/${guestId}`).expect(disabled);
    f.releaseQueued();
    await service;
    f.assertNoEffects();
  } finally { f.close(); }
});

test('existing human authentication, Host and Origin precede the guest boundary', async () => {
  const f = await fixture();
  try {
    for (const route of ['/api/guests', `/api/guests/${guestId}/oauth/callback`, `/api/guests/${guestId}/index.html`]) {
      await f.call('get', route, false).expect(401);
    }
    await f.call('put', `/api/guests/${guestId}/capabilities`, false).send({ granted }).expect(401);
    for (const origin of ['null', 'https://attacker.test']) {
      await f.call('put', `/api/guests/${guestId}/capabilities`).set('Origin', origin).send({ granted }).expect(403);
    }
    await f.call('get', '/api/guests').set('Host', 'attacker.test').expect(403);
    await f.call('put', `/api/guests/${guestId}/capabilities`).unset('Origin').send({ granted }).expect(403);
    await f.call('get', '/api/guests').expect(disabled);
    f.assertNoEffects();
  } finally { f.close(); }
});

test('the legacy anonymous OAuth exemption still terminates at the disabled feature', async () => {
  const f = await fixture(false);
  try {
    await f.call('get', '/api/guests', false).expect(401);
    await f.call('get', `/api/guests/${guestId}/oauth/callback?error=access_denied`, false).expect(disabled);
    f.assertNoEffects();
  } finally { f.close(); }
});

test('minted legacy guest URL tokens cannot enable assets or control GETs', async () => {
  const f = await fixture(false);
  try {
    const session = await f.call('post', '/auth/session', false).send({ password: 'fixture-password' }).expect(200);
    const cookie = session.headers['set-cookie'];
    assert.ok(cookie);
    const mint = await f.call('post', '/auth/url-token', false).set('Cookie', cookie)
      .send({ scope: `guest:${guestId}` }).expect(200);
    const query = `oc_url_token=${encodeURIComponent(mint.body.token)}`;
    for (const route of ['index.html', 'main.js', 'oauth/status', 'service/status', 'oauth/callback']) {
      await f.call('get', `/api/guests/${guestId}/${route}?${query}`, false).expect(disabled);
    }
    await f.call('get', `/api/guests/${guestId}/oauth/callback?error=access_denied&state=wrong&${query}`, false).expect(disabled);
    f.assertNoEffects();
  } finally { f.close(); }
});

test('first-party handlers, plugin management and native route forwarding are not guest prefixes', async () => {
  const f = await fixture();
  try {
    await f.call('get', '/api/github/pr/status').expect(400, { error: 'directory and branch are required' });
    await f.call('get', '/api/linear/issues/get').expect(400, { error: 'id is required' });
    await f.call('get', '/api/config/plugins/registry').expect(200, { results: [] });
    f.assertNoEffects();
    for (const [method, route] of [['get', '/api/guests-other'], ['put', '/api/guests-other'],
      ['get', '/api/guests.other'], ['get', '/api/unrelated'], ['post', '/api/session'],
      ['post', '/api/session/native/prompt_async'], ['get', '/api/session/native/message']]) {
      await f.call(method, route).expect(200, { forwarded: true });
    }
    await f.call('get', '/api/global/event').expect(200, 'data: {"type":"fixture"}\n\n');
    assert.equal(f.effects.proxy.length, 8);
    await f.call('get', '/assets/first-party.js').expect(200, 'firstParty();');
    assert.equal(f.effects.proxy.length, 8);
  } finally { f.close(); }
});
