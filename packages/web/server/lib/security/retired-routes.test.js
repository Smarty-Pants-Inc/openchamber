import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRetiredRoutePath } from './retired-routes.js';

test('every spelling of the retired terminal namespace is classified as retired', () => {
  for (const url of [
    '/api/terminal', '/api/terminal/', '/api/terminal/ws', '/api/terminal/ws?oc_url_token=x',
    '/api/terminal/removed-fixture/resize', '/API/Terminal/ws', '/api/%74erminal/sessions',
    '/api/%2574erminal/sessions', '/api//terminal/create', '//api/terminal/shells',
    '/api/session/../terminal/shells', '/api/./terminal', '/api\\terminal\\ws',
  ]) assert.equal(isRetiredRoutePath(url), true, url);
});

test('remaining routes and look-alike names are not retired', () => {
  for (const url of [
    '/api/global/event/ws', '/api/event/ws', '/api/dictation/ws', '/api/dev-tunnel',
    '/api/openchamber/realtime-proxy/ws', '/api/session/abc/voice/socket', '/api/terminals',
    '/api/terminal-theme', '/api/session/terminal', '/terminal', '/api', '/', '', '/api/fs/exec',
  ]) assert.equal(isRetiredRoutePath(url), false, url);
});
