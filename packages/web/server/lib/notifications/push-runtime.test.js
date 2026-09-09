import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPushRuntime } from './push-runtime.js';

const createRuntime = () => createPushRuntime({
  fsPromises: {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => JSON.stringify({ version: 1, subscriptionsBySession: {} })),
    writeFile: vi.fn(async () => {}),
  },
  path: { dirname: () => '/tmp' },
  webPush: {
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
    sendNotification: vi.fn(async () => {}),
    setVapidDetails: vi.fn(),
  },
  PUSH_SUBSCRIPTIONS_FILE_PATH: '/tmp/push-subscriptions.json',
  readSettingsFromDiskMigrated: vi.fn(async () => ({})),
  writeSettingsToDisk: vi.fn(async () => {}),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('push runtime visibility tracking', () => {
  it('keeps visible UI state when another client reports hidden', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    runtime.updateUiVisibility('visible-client', true);
    runtime.updateUiVisibility('hidden-client', false);

    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isUiVisible('visible-client')).toBe(true);
    expect(runtime.isUiVisible('hidden-client')).toBe(false);

    vi.advanceTimersByTime(30_001);

    expect(runtime.isAnyUiVisible()).toBe(false);
    expect(runtime.isUiVisible('visible-client')).toBe(false);
  });

  it('treats only mobile platforms as non-interactive for isAnyInteractiveClientVisible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    // Only the phone (foreground) is connected → no interactive client to absorb the notification.
    runtime.updateUiVisibility('phone', true, 'ios');
    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A visible desktop counts as interactive → suppress mobile push.
    runtime.updateUiVisibility('desktop', true, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);

    // Desktop hidden again → back to mobile-only, push should flow to the phone.
    runtime.updateUiVisibility('desktop', false, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A client that never reported a platform is treated as interactive (conservative).
    runtime.updateUiVisibility('legacy', true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);
  });

  it('remembers the last platform when a heartbeat omits it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();
    runtime.updateUiVisibility('phone', true, 'android');
    runtime.updateUiVisibility('phone', true); // heartbeat without platform
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);
  });

  it('returns one persisted VAPID identity to concurrent callers', async () => {
    let settings = { projects: [{ id: 'project-1', path: '/project' }] };
    let settingsWriteLock = Promise.resolve();
    const writeSettingsToDisk = (nextOrMutation) => {
      const write = settingsWriteLock.then(async () => {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The writer accepts an object or a callback.
        settings = typeof nextOrMutation === 'function' ? await nextOrMutation(settings) : nextOrMutation;
      });
      settingsWriteLock = write.catch(() => {});
      return write;
    };
    const generateVAPIDKeys = vi.fn(() => ({ publicKey: 'public', privateKey: 'private' }));
    const runtime = createPushRuntime({
      fsPromises: { mkdir: vi.fn(async () => {}), readFile: vi.fn(), writeFile: vi.fn() },
      path: { dirname: () => '/tmp' },
      webPush: { generateVAPIDKeys, sendNotification: vi.fn(), setVapidDetails: vi.fn() },
      PUSH_SUBSCRIPTIONS_FILE_PATH: '/tmp/push-subscriptions.json',
      readSettingsFromDiskMigrated: async () => ({ ...settings }),
      writeSettingsToDisk,
    });

    const [first, second] = await Promise.all([runtime.getOrCreateVapidKeys(), runtime.getOrCreateVapidKeys()]);

    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ publicKey: 'public', privateKey: 'private' });
    expect(second).toEqual(first);
    expect(settings.projects).toEqual([{ id: 'project-1', path: '/project' }]);
  });
});
