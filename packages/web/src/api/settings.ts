import type { SettingsAPI, SettingsLoadResult, SettingsPayload } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { SettingsConflictError } from '@openchamber/ui/lib/projectSettingsMerge';

const SETTINGS_ENDPOINT = '/api/config/settings';
const RELOAD_ENDPOINT = '/api/config/reload';

const sanitizePayload = (data: unknown): SettingsPayload => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid settings response');
  return data as SettingsPayload;
};

export const createWebSettingsAPI = (): SettingsAPI => ({
  async load(): Promise<SettingsLoadResult> {
    const response = await runtimeFetch(SETTINGS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to load settings: ${response.statusText}`);
    }
    let revision: string | undefined;
    if (response.headers.get('X-OpenChamber-Settings-CAS') === '1') {
      const tag = response.headers.get('ETag');
      if (tag === null || !/^"[!#-~\x80-\xff]*"$/.test(tag)) {
        throw new Error('Settings server did not provide a strong revision');
      }
      revision = tag;
    }

    const payload = sanitizePayload(await response.json());
    return { settings: payload, source: 'web', revision };
  },

  async save(changes: Partial<SettingsPayload>, options?: { ifMatch?: string; keepalive?: boolean }): Promise<SettingsPayload> {
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
    if (options?.ifMatch) headers.set('If-Match', options.ifMatch);
    const response = await runtimeFetch(SETTINGS_ENDPOINT, {
      method: 'PUT',
      headers,
      body: JSON.stringify(changes),
      // A save started while the page unloads must outlive it (sendBeacon cannot carry If-Match).
      ...(options?.keepalive ? { keepalive: true } : {}),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      if (response.status === 412 && options?.ifMatch) {
        throw new SettingsConflictError(error.error || 'Settings precondition rejected (412)');
      }
      throw new Error(error.error || 'Failed to save settings');
    }

    const payload = sanitizePayload(await response.json());
    return payload;
  },

  async restartOpenCode(): Promise<{ restarted: boolean }> {
    const response = await runtimeFetch(RELOAD_ENDPOINT, { method: 'POST' });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Failed to restart the server');
    }
    return { restarted: true };
  },
});
