import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { registerOpenCodeRoutes } from './routes.js';
import { createSettingsRuntime } from './settings-runtime.js';

const runtimes = [];

const createApp = async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-routes-'));
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH: path.join(tempRoot, 'settings.json'),
    sanitizeProjects: (projects) => projects,
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings: (_current, changes) => changes,
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => Array.isArray(values) ? values : [],
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
  });
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.set('Access-Control-Expose-Headers', 'x-next-cursor');
    next();
  });
  registerOpenCodeRoutes(app, {
    crypto,
    formatSettingsResponse: (settings) => settings,
    readSettingsFromDiskMigrated: runtime.readSettingsFromDiskMigrated,
    persistSettings: runtime.persistSettings,
  });
  runtimes.push(tempRoot);
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

    const updated = await request(app)
      .put('/api/config/settings')
      .send({ value: 'saved' })
      .expect(200);
    expect(updated.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(updated.headers.etag).not.toBe(initial.headers.etag);
    expect(updated.headers['x-openchamber-settings-cas']).toBe('1');
    expect(updated.body).toEqual({ value: 'saved' });
  });

  it('allows one of two same-revision writers and rejects the stale writer', async () => {
    const app = await createApp();
    const initial = await request(app).get('/api/config/settings').expect(200);

    const responses = await Promise.all([
      request(app).put('/api/config/settings').set('If-Match', initial.headers.etag).send({ value: 'first' }),
      request(app).put('/api/config/settings').set('If-Match', initial.headers.etag).send({ value: 'second' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const success = responses.find((response) => response.status === 200);
    expect(success.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    const stale = responses.find((response) => response.status === 412);
    expect(stale.body).toEqual({ error: 'Settings changed before this update could be saved.' });
  });

  it('rejects weak matching input as stale without writing settings', async () => {
    const app = await createApp();
    const initial = await request(app).get('/api/config/settings').expect(200);

    await request(app)
      .put('/api/config/settings')
      .set('If-Match', `W/${initial.headers.etag}`)
      .send({ value: 'ignored' })
      .expect(412, { error: 'Settings changed before this update could be saved.' });

    const current = await request(app).get('/api/config/settings').expect(200);
    expect(current.body).toEqual(initial.body);
  });

  it('rejects malformed conditional headers without attempting a write', async () => {
    const app = await createApp();

    await request(app)
      .put('/api/config/settings')
      .set('If-Match', 'not-an-entity-tag')
      .send({ value: 'ignored' })
      .expect(400, { error: 'If-Match must be a valid entity-tag list.' });

    const current = await request(app).get('/api/config/settings').expect(200);
    expect(current.body).not.toHaveProperty('value');
  });
});
