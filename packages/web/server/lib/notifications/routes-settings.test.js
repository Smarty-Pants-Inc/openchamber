import { describe, expect, it, vi } from 'vitest';

import { registerNotificationRoutes } from './routes.js';

const createRegistry = () => {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  }
  return { app, getPost: (routePath) => routes.get(`post ${routePath}`) };
};

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe('notification settings writer', () => {
  it('does not replace a public origin that appeared before its queued transform', async () => {
    const { app, getPost } = createRegistry();
    let settings = { projects: [{ id: 'project-1', path: '/project' }] };
    const setPushInitialized = vi.fn();
    registerNotificationRoutes(app, {
      ensurePushInitialized: async () => {},
      getUiSessionTokenFromRequest: () => 'ui-token',
      writeSettingsToDisk: async (mutation) => {
        settings = { ...settings, publicOrigin: 'https://browser.example.test' };
        settings = await mutation(settings);
      },
      addOrUpdatePushSubscription: vi.fn(async () => {}),
      setPushInitialized,
    });

    const response = createResponse();
    await getPost('/api/push/subscribe')({
      body: {
        endpoint: 'https://push.example.test/subscription',
        keys: { p256dh: 'key', auth: 'auth' },
        origin: 'https://stale.example.test',
      },
      headers: {},
    }, response);

    expect(response).toMatchObject({ statusCode: 200, body: { ok: true } });
    expect(settings).toEqual({
      projects: [{ id: 'project-1', path: '/project' }],
      publicOrigin: 'https://browser.example.test',
    });
    expect(setPushInitialized).not.toHaveBeenCalled();
  });
});
