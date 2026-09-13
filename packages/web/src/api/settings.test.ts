import { beforeEach, expect, mock, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { SettingsConflictError } from '@openchamber/ui/lib/projectSettingsMerge';

let request: (path: string, init?: RequestInit) => Promise<Response>;
mock.module('@openchamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: (path: string, init?: RequestInit) => request(path, init),
}));
const { createWebSettingsAPI } = await import('./settings');
const settingsResponse = (revision: string) => Response.json({}, {
  headers: { ETag: revision, 'X-OpenChamber-Settings-CAS': '1' },
});
beforeEach(() => {
  request = async () => { throw new Error('Unexpected request'); };
});

test('returns the exact loaded snapshot revision and sends the selected precondition', async () => {
  const api = createWebSettingsAPI();
  request = async () => settingsResponse('"loaded"');
  expect((await api.load()).revision).toBe('"loaded"');
  request = async (_path, init) => {
    expect(new Headers(init?.headers).get('If-Match')).toBe('"selected"');
    return settingsResponse('"saved"');
  };
  await api.save({ projects: [] }, { ifMatch: '"selected"' });
});

test('distinguishes legacy servers from an advertised but invalid conditional contract', async () => {
  const api = createWebSettingsAPI();
  request = async () => Response.json({}, { headers: { ETag: 'W/"legacy"' } });
  expect((await api.load()).revision).toBe(undefined);
  request = async () => settingsResponse('W/"weak"');
  await expect(api.load()).rejects.toThrow('strong revision');
});

test('reports a rejected precondition without replaying the mutation', async () => {
  const api = createWebSettingsAPI();
  let requests = 0;
  request = async () => {
    requests += 1;
    return Response.json({ error: 'Settings changed' }, { status: 412 });
  };
  const result = api.save({ projects: [] }, { ifMatch: '"old"' });
  await rejects(result, SettingsConflictError);
  await expect(result).rejects.toThrow('Settings changed');
  expect(requests).toBe(1);
});

for (const status of [401, 403, 409, 500, 503]) test(`status ${status} does not certify a precondition rejection`, async () => {
  request = async () => Response.json({ error: 'Settings changed (412)' }, { status });
  await rejects(createWebSettingsAPI().save({ projects: [] }, { ifMatch: '"old"' }), error => !(error instanceof SettingsConflictError));
});

test('an unconditional 412 or transport error does not certify safe conditional recovery', async () => {
  request = async () => Response.json({ error: 'Settings changed' }, { status: 412 });
  await rejects(createWebSettingsAPI().save({ pwaAppName: 'Preference' }), error => !(error instanceof SettingsConflictError));
  const error = new Error('Disconnected');
  request = async () => { throw error; };
  await rejects(createWebSettingsAPI().save({ projects: [] }, { ifMatch: '"old"' }), received => received === error);
});
