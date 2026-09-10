import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { registerOpenCodeRoutes } from './routes.js';
import { createSettingsRuntime } from './settings-runtime.js';
import { createSettingsHelpers } from './settings-helpers.js';
import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';
import { normalizeOptionalPath, normalizeTunnelMode, normalizeTunnelProvider } from '../tunnels/types.js';

const runtimes = [];

const createApp = async (initialSettings) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-routes-'));
  runtimes.push(tempRoot);
  const normalization = createSettingsNormalizationRuntime({
    os: { homedir: () => tempRoot }, path, processLike: { platform: process.platform, env: {} },
    tunnelBootstrapTtlDefaultMs: 600000, tunnelBootstrapTtlMinMs: 60000, tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000, tunnelSessionTtlMinMs: 3600000, tunnelSessionTtlMaxMs: 604800000,
  });
  const helpers = createSettingsHelpers({ ...normalization, normalizeOptionalPath, normalizeTunnelMode, normalizeTunnelProvider });
  const runtime = createSettingsRuntime({
    ...normalization,
    ...helpers,
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH: path.join(tempRoot, 'settings.json'),
    resolveDirectoryCandidate: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
  });
  if (initialSettings) await runtime.writeSettingsToDisk(initialSettings);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.set('Access-Control-Expose-Headers', 'x-next-cursor');
    next();
  });
  registerOpenCodeRoutes(app, {
    crypto,
    formatSettingsResponse: helpers.formatSettingsResponse,
    readSettingsFromDiskMigrated: runtime.readSettingsFromDiskMigrated,
    persistSettings: runtime.persistSettings,
  });
  return app;
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((tempRoot) => fsPromises.rm(tempRoot, { recursive: true, force: true })));
});

describe('settings conditional routes', () => {
  it('returns a strong revision and accepts unguarded compatible writes', async () => {
    const app = await createApp();
    const initial = await request(app).get('/api/config/settings').expect(200);
    expect(initial.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(initial.headers.etag).not.toMatch(/^W\//);
    expect(initial.headers['x-openchamber-settings-cas']).toBe('1');
    expect(initial.headers['access-control-expose-headers']).toBe('x-next-cursor, ETag, X-OpenChamber-Settings-CAS');

    const updated = await request(app).put('/api/config/settings').send({ pwaAppName: 'saved' }).expect(200);
    expect(updated.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(updated.headers.etag).not.toBe(initial.headers.etag);
    expect(updated.headers['x-openchamber-settings-cas']).toBe('1');
    expect(updated.body).toMatchObject({ pwaAppName: 'saved' });
  });

  it('allows one of two same-revision writers and rejects the stale writer', async () => {
    const app = await createApp();
    const initial = await request(app).get('/api/config/settings').expect(200);
    const responses = await Promise.all([
      request(app).put('/api/config/settings').set('If-Match', initial.headers.etag).send({ pwaAppName: 'first' }),
      request(app).put('/api/config/settings').set('If-Match', initial.headers.etag).send({ pwaAppName: 'second' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const success = responses.find((response) => response.status === 200);
    expect(success.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    const stale = responses.find((response) => response.status === 412);
    expect(stale.body).toEqual({ error: 'Settings changed before this update could be saved.' });
  });

  it.each([false, true])('formats GET and PUT once with stored token=%s', async (withToken) => {
    const app = await createApp(withToken ? { managedRemoteTunnelToken: 'synthetic-test-token' } : undefined);
    const initial = await request(app).get('/api/config/settings').expect(200);
    const updated = await request(app).put('/api/config/settings').set('If-Match', initial.headers.etag)
      .send({ pwaAppName: 'Changed' }).expect(200);
    const current = await request(app).get('/api/config/settings').expect(200);
    expect(updated.body.hasManagedRemoteTunnelToken).toBe(withToken);
    expect(updated.body).not.toHaveProperty('managedRemoteTunnelToken');
    expect(updated.text).not.toContain('synthetic-test-token');
    expect(updated.text).toBe(current.text);
    expect(updated.headers.etag).toBe(current.headers.etag);
  });

  it('accepts consecutive conditional writes using the returned PUT revision', async () => {
    const app = await createApp();
    const initial = await request(app).get('/api/config/settings').expect(200);
    const first = await request(app).put('/api/config/settings').set('If-Match', initial.headers.etag)
      .send({ pwaAppName: 'First' }).expect(200);
    const second = await request(app).put('/api/config/settings').set('If-Match', first.headers.etag)
      .send({ pwaAppName: 'Second' }).expect(200);
    const current = await request(app).get('/api/config/settings').expect(200);
    expect(second.text).toBe(current.text);
    expect(second.headers.etag).toBe(current.headers.etag);
  });

  it('rejects weak matching input as stale without writing settings', async () => {
    const app = await createApp();
    const initial = await request(app).get('/api/config/settings').expect(200);
    await request(app).put('/api/config/settings').set('If-Match', `W/${initial.headers.etag}`)
      .send({ pwaAppName: 'ignored' }).expect(412, { error: 'Settings changed before this update could be saved.' });
    const current = await request(app).get('/api/config/settings').expect(200);
    expect(current.body).toEqual(initial.body);
  });

  it('rejects malformed conditional headers without attempting a write', async () => {
    const app = await createApp();
    await request(app).put('/api/config/settings').set('If-Match', 'not-an-entity-tag')
      .send({ pwaAppName: 'ignored' }).expect(400, { error: 'If-Match must be a valid entity-tag list.' });
    const current = await request(app).get('/api/config/settings').expect(200);
    expect(current.body).not.toHaveProperty('pwaAppName');
  });
});
