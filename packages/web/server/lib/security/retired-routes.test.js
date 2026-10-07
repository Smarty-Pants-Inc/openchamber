import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRetiredRoutePath, isRetiredRouteRequest } from './retired-routes.js';

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
    '/api/global/event/ws', '/api/event/ws', '/api/dictation/ws',
    '/api/openchamber/realtime-proxy/ws', '/api/session/abc/voice/socket', '/api/terminals',
    '/api/terminal-theme', '/api/session/terminal', '/terminal', '/api', '/', '',
  ]) assert.equal(isRetiredRoutePath(url), false, url);
});

test('security round 2: a malformed escape or deep encoding never hides the retired namespace', () => {
  let deep = 'terminal';
  for (let round = 0; round < 6; round += 1) deep = encodeURIComponent(deep).replace(/t/, '%74');
  for (const url of [
    '/api/%74erminal/ws%', '/api/%74erminal/ws%zz', '/api/%2574erminal/ws%E0%A4%A', // valid escapes decode past a malformed tail
    `/api/${deep}/ws`, // six rounds of encoding
    `/api/${Array.from({ length: 17 }).reduce((v) => v.replace(/%/g, '%25'), '%74erminal')}/ws`, // still decoding past the bound: fail closed
  ]) assert.equal(isRetiredRoutePath(url), true, url);
  for (const url of ['/api/global/event/ws%', '/api/%zz/ws']) assert.equal(isRetiredRoutePath(url), false, url);
});

// smarty-code#1398 slice 2: host-power routes share the classifier and the first upgrade listener.
const HOST_POWER_RETIRED = [
  ['POST', '/api/fs/exec'], ['GET', '/api/fs/exec/job-1'], ['POST', '/api/system/shutdown'],
  ['GET', '/api/openchamber/update-check'], ['POST', '/api/openchamber/update-install'],
  ['GET', '/api/openchamber/tunnel/status'], ['POST', '/api/openchamber/tunnel/start'], ['PUT', '/api/openchamber/tunnel/managed-remote-token'],
  ['POST', '/api/openchamber/relay/enable'], ['GET', '/api/openchamber/relay/status'], ['GET', '/api/dev-tunnel?port=3000'],
  ['POST', '/api/git/identities'], ['PUT', '/api/git/identities/x'], ['DELETE', '/api/git/identities/x'],
  ['POST', '/api/git/set-identity'], ['GET', '/api/git/discover-credentials'], ['POST', '/api/git/integrate/run'],
  ['POST', '/api/git/stage'], ['POST', '/api/git/stash/pop'], ['POST', '/api/git/commit'], ['POST', '/api/git/push'],
  ['POST', '/api/git/branches'], ['DELETE', '/api/git/branches'], ['PUT', '/api/git/branches/rename'],
  ['DELETE', '/api/git/remotes'], ['DELETE', '/api/git/remote-branches'], ['POST', '/api/git/reset-to-commit'],
  // Worktree writes (openchamber#554 round 6), including spellings.
  ['POST', '/api/git/worktrees'], ['DELETE', '/api/git/worktrees'], ['POST', '/api/git/worktrees/validate'],
  ['POST', '/api/git/worktrees/preview'], ['POST', '/API/Git/Worktrees'], ['POST', '/api/git/%77orktrees/'],
  ['GET', '/api/quota/credentials/exe-dev'], ['POST', '/api/quota/credentials/cursor/import'],
  ['DELETE', '/api/provider/openai/auth'],
  // The engine's credential API (SDK auth.set / auth.remove).
  ['PUT', '/api/auth/openai'], ['DELETE', '/api/auth/openai'], ['PATCH', '/api/auth/openai'],
  ['PUT', '/API/Auth/openai'], ['PUT', '/api/%61uth/openai'], ['DELETE', '/api//auth/anthropic'], ['PUT', '/api/session/../auth/openai'],
  // Alternate spellings reach the same namespaces.
  ['POST', '/API/Git/Stage'], ['POST', '/api/%67it/%73tage'], ['POST', '/api//fs/exec'], ['POST', '/api/git/../system/shutdown'],
  ['DELETE', '/api/provider/%6fpenai/%61uth/x%zz'], ['POST', '/api\\git\\push'],
];
// Kept: the read routes the Git view uses, other fs/system/openchamber/quota/provider routes and look-alikes.
const HOST_POWER_KEPT = [
  ['GET', '/api/git/status'], ['GET', '/api/git/diff'], ['GET', '/api/git/log'], ['GET', '/api/git/branches'],
  ['GET', '/api/git/identities'], ['GET', '/api/git/remotes'], ['GET', '/api/git/stashes'], ['POST', '/api/git/commit-summaries'],
  ['GET', '/api/git/commit-files'], ['GET', '/api/git/worktrees'], ['GET', '/api/git/worktrees/bootstrap-status'],
  ['GET', '/api/git/worktree-type'], ['POST', '/api/git/worktree-type'], ['HEAD', '/api/git/branches'],
  ['GET', '/api/fs/read'], ['POST', '/api/fs/upload'], ['GET', '/api/fs/execs'], ['POST', '/api/system/dev-shutdown'], ['GET', '/api/system/info'],
  ['GET', '/api/openchamber/models-metadata'], ['GET', '/api/openchamber/tunnels'], ['GET', '/api/quota/providers'], ['GET', '/api/quota/exe-dev'],
  ['PUT', '/api/provider'], ['GET', '/api/provider/openai/source'], ['GET', '/api/provider/auth'], ['POST', '/api/provider/openai/oauth/callback'],
  // Better Auth's sign-in, callback and session routes and the legacy reset refusal share /api/auth.
  ['POST', '/api/auth/sign-in/social'], ['GET', '/api/auth/callback/google'], ['GET', '/api/auth/get-session'],
  ['POST', '/api/auth/sign-out'], ['POST', '/api/auth/reset'],
];

test('every host-power route and its alternate spellings are retired for its retired methods', () => {
  for (const [method, url] of HOST_POWER_RETIRED) {
    assert.equal(isRetiredRoutePath(url, method), true, `${method} ${url}`);
    assert.equal(isRetiredRoutePath(url), true, `upgrade ${url}`);
  }
});

test('kept routes stay served: only the retired methods of a shared path are refused', () => {
  for (const [method, url] of HOST_POWER_KEPT) assert.equal(isRetiredRoutePath(url, method), false, `${method} ${url}`);
});

test('preflights are classified by the method they request; a bare OPTIONS on a retired namespace fails closed', () => {
  const request = (url, requested) => ({ method: 'OPTIONS', originalUrl: url, headers: requested ? { 'access-control-request-method': requested } : {} });
  assert.equal(isRetiredRouteRequest(request('/api/git/branches', 'POST')), true);
  assert.equal(isRetiredRouteRequest(request('/api/git/branches', 'GET')), false);
  assert.equal(isRetiredRouteRequest(request('/api/git/branches')), true);
  assert.equal(isRetiredRouteRequest(request('/api/terminal/ws', 'GET')), true);
  assert.equal(isRetiredRouteRequest(request('/api/fs/exec', 'POST')), true);
  assert.equal(isRetiredRouteRequest(request('/api/git/status', 'GET')), false);
  assert.equal(isRetiredRouteRequest(request('/api/config/settings')), false);
  assert.equal(isRetiredRouteRequest({ method: 'POST', originalUrl: '/api/git/push', headers: {} }), true);
  assert.equal(isRetiredRouteRequest({ method: 'GET', originalUrl: '/api/git/branches', headers: {} }), false);
  assert.equal(isRetiredRouteRequest(request('/api/auth/openai', 'PUT')), true);
  assert.equal(isRetiredRouteRequest(request('/api/auth/sign-in/social', 'POST')), false);
});
