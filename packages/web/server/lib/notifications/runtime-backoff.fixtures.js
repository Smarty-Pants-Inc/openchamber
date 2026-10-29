import { afterEach } from 'bun:test';
import { createNotificationTriggerRuntime } from './runtime.js';
import { createNotificationTemplateRuntime } from './template-runtime.js';
import { prepareNotificationLastMessage } from './message.js';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

export const createFixture = (overrides = {}) => {
  let now = 100_000;
  Date.now = () => now;
  const settings = {
    notificationMode: 'always',
    nativeNotificationsEnabled: true,
    notificationTemplates: {
      completion: { title: '{session_name}', message: '{last_message}' },
      subtask: { title: 'Subtask {session_name}', message: '{last_message}' },
      error: { title: 'Error {session_name}', message: '{last_message}' },
    },
    ...overrides,
  };
  const reads = [];
  const desktop = [];
  const push = [];
  const apns = [];
  let focused = false;
  let respond = async (url) => Response.json({ id: url.pathname.split('/').pop(), title: 'Session title' });
  let respondMessage = async () => Response.json([{
    info: { id: 'm1', role: 'assistant', finish: 'stop' },
    parts: [{ type: 'text', text: '**Fetched answer**' }],
  }]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    reads.push({ url, init });
    if (url.pathname.endsWith('/message')) return respondMessage(url);
    return respond(url);
  };
  const deps = {
    readSettingsFromDisk: async () => settings,
    buildOpenCodeUrl: (path) => `http://notification.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    resolveGitBinaryForSpawn: () => 'git',
  };
  const template = createNotificationTemplateRuntime(deps);
  const runtime = createNotificationTriggerRuntime({
    ...deps,
    ...template,
    prepareNotificationLastMessage,
    emitDesktopNotification: (payload) => { desktop.push(payload); return true; },
    broadcastUiNotification: () => {},
    sendPushToAllUiSessions: async (payload) => { push.push(payload); },
    sendApnsToAllUiSessions: async (payload) => { apns.push(payload); },
    getIsWindowFocused: () => focused,
  });
  const event = (sessionID = 's1', directory = '/project/a', finish = 'stop', inline = true) => {
    const info = { id: 'm1', sessionID, role: 'assistant', finish };
    if (inline) info.parts = [{ type: 'text', text: '**Inline answer**' }];
    return { type: 'message.updated', properties: { directory, info } };
  };
  return {
    runtime, settings, reads, desktop, push, apns, event,
    details: () => reads.filter(({ url }) => !url.pathname.endsWith('/message')),
    at: (time) => { now = time; },
    focus: (value) => { focused = value; },
    respond: (handler) => { respond = handler; },
    respondMessage: (handler) => { respondMessage = handler; },
    trigger: (payload = event(), directory) => runtime.maybeSendPushForTrigger(payload, directory),
  };
};
