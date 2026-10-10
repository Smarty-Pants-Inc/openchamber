import { beforeEach, expect, test } from 'bun:test';
import { createShareToken, listShareTokens, resetShareTokensStore, ShareTokenRequestError, useShareTokensStore } from './shareTokens';
import { useAuthSessionStore } from './runtime-auth-expiry';

// smarty-dev#799 L2: the iPhone codes against fakes of the gateway's /api/me/share-tokens contract.
type Wire = Record<string, string | null> | Record<string, string | null>[];
const json = (body: Wire, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string };
const gateway = (routes: Record<string, () => Response>) => {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    const route = routes[`${method} ${url}`];
    if (!route) throw new Error(`unexpected ${method} ${url}`);
    return route();
  };
  return { calls, fetcher };
};
const a = { id: 'a', createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: '2026-10-09T08:00:00.000Z' };
const b = { id: 'b', createdAt: '2026-10-05T10:00:00.000Z', lastUsedAt: null };
const store = () => useShareTokensStore.getState();
const deferredResponse = () => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolveResponse, rejectResponse) => { resolve = resolveResponse; reject = rejectResponse; });
  return { promise, resolve, reject };
};

beforeEach(() => resetShareTokensStore());

test('the list parses the rows; a missing lastUsedAt reads as never used; a failure throws, never an empty list', async () => {
  const { fetcher, calls } = gateway({ 'GET /api/me/share-tokens': () => json([a, { id: 'b', createdAt: b.createdAt }]) });
  expect(await listShareTokens(fetcher)).toEqual([a, b]);
  expect(calls).toEqual([{ url: '/api/me/share-tokens', method: 'GET' }]);
  await expect(listShareTokens(gateway({ 'GET /api/me/share-tokens': () => json({ error: 'no' }, 500) }).fetcher)).rejects.toBeInstanceOf(ShareTokenRequestError);
  await expect(listShareTokens(gateway({ 'GET /api/me/share-tokens': () => json({ not: 'a list' }) }).fetcher)).rejects.toThrow();
});

test('a failed load shows the failure, and a retry shows the rows', async () => {
  await store().load(gateway({ 'GET /api/me/share-tokens': () => json({}, 503) }).fetcher);
  expect(store().list).toEqual({ state: 'failed' });
  await store().load(gateway({ 'GET /api/me/share-tokens': () => json([a]) }).fetcher);
  expect(store().list).toEqual({ state: 'ready', tokens: [a] });
});

test('creating a code keeps its secret for this page only and lists it first, never used', async () => {
  const created = { id: 'c', token: 'secret-code', createdAt: '2026-10-10T09:00:00.000Z' };
  const { fetcher, calls } = gateway({ 'GET /api/me/share-tokens': () => json([a]), 'POST /api/me/share-tokens': () => json(created, 201) });
  await store().load(fetcher);
  await store().create(fetcher);
  expect(store().created).toEqual(created);
  expect(store().list).toEqual({ state: 'ready', tokens: [{ id: 'c', createdAt: created.createdAt, lastUsedAt: null }, a] });
  expect(calls.map(call => call.method)).toEqual(['GET', 'POST']);
  store().forgetCreated();
  expect(store().created).toBeNull();
  expect(JSON.stringify(store())).not.toContain('secret-code');
  expect(await createShareToken(gateway({ 'POST /api/me/share-tokens': () => json(created, 201) }).fetcher)).toEqual(created);
});

test('a creation that resolves after the page closes cannot show its code on a later visit', async () => {
  const created = { id: 'c', token: 'secret-code', createdAt: '2026-10-10T09:00:00.000Z' };
  const pending = deferredResponse();
  await store().load(gateway({ 'GET /api/me/share-tokens': () => json([a]) }).fetcher);
  const creation = store().create(() => pending.promise);
  expect(store().creating).toBe(true);
  store().forgetCreated();
  pending.resolve(json(created, 201));
  await creation;
  await store().load(gateway({ 'GET /api/me/share-tokens': () => json([a, { id: created.id, createdAt: created.createdAt }]) }).fetcher);
  expect(store()).toMatchObject({ created: null, creating: false, createFailed: false });
  expect(JSON.stringify(store())).not.toContain(created.token);
});

test('switching accounts during creation discards the previous account code and allows a new one', async () => {
  const created = { id: 'c', token: 'previous-code', createdAt: '2026-10-10T09:00:00.000Z' };
  const pending = deferredResponse();
  await store().load(gateway({ 'GET /api/me/share-tokens': () => json([]) }).fetcher);
  const creation = store().create(() => pending.promise);
  useAuthSessionStore.getState().markReauthenticating();
  useAuthSessionStore.getState().markAuthenticated();
  pending.resolve(json(created, 201));
  await creation;
  expect(store()).toMatchObject({ created: null, creating: false, createFailed: false, list: { state: 'ready', tokens: [] } });
  expect(JSON.stringify(store())).not.toContain(created.token);
  const current = { id: 'd', token: 'current-code', createdAt: created.createdAt };
  await store().create(gateway({ 'POST /api/me/share-tokens': () => json(current, 201) }).fetcher);
  expect(store().created).toEqual(current);
  store().forgetCreated();
  expect(store().created).toBeNull();
});

test('a creation that resolves after sign-out cannot publish a code before login finishes', async () => {
  const pending = deferredResponse();
  await store().load(gateway({ 'GET /api/me/share-tokens': () => json([]) }).fetcher);
  const creation = store().create(() => pending.promise);
  useAuthSessionStore.getState().markReauthenticating();
  pending.resolve(json({ id: 'c', token: 'previous-code', createdAt: a.createdAt }, 201));
  await creation;
  const duringLogin = store();
  useAuthSessionStore.getState().markAuthenticated();
  expect(duringLogin).toMatchObject({ created: null, creating: false, createFailed: false, list: { state: 'ready', tokens: [] } });
  expect(store().created).toBeNull();
  const created = { id: 'd', token: 'current-code', createdAt: a.createdAt };
  await store().create(gateway({ 'POST /api/me/share-tokens': () => json(created, 201) }).fetcher);
  expect(store().created).toEqual(created);
});

test('a creation failure during reauthentication is discarded and creation waits for login', async () => {
  const pending = deferredResponse();
  const creation = store().create(() => pending.promise);
  useAuthSessionStore.getState().markReauthenticating();
  pending.reject(new Error('request failed'));
  await creation;
  const duringLogin = store();
  const gatewayAfterSignOut = gateway({ 'POST /api/me/share-tokens': () => json({ id: 'c', token: 'previous-code', createdAt: a.createdAt }, 201) });
  await store().create(gatewayAfterSignOut.fetcher);
  useAuthSessionStore.getState().markAuthenticated();
  expect(duringLogin).toMatchObject({ created: null, creating: false, createFailed: false });
  expect(gatewayAfterSignOut.calls).toEqual([]);
});

test('an obsolete completion cannot clear or replace a new visit creation', async () => {
  const previous = deferredResponse();
  const current = deferredResponse();
  await store().load(gateway({ 'GET /api/me/share-tokens': () => json([]) }).fetcher);
  const oldCreation = store().create(() => previous.promise);
  store().forgetCreated();
  const newCreation = store().create(() => current.promise);
  previous.resolve(json({ id: 'c', token: 'previous-code', createdAt: a.createdAt }, 201));
  await oldCreation;
  expect(store()).toMatchObject({ created: null, creating: true, createFailed: false });
  const created = { id: 'd', token: 'current-code', createdAt: a.createdAt };
  current.resolve(json(created, 201));
  await newCreation;
  expect(store()).toMatchObject({ created, creating: false, createFailed: false });
});

test('an obsolete failure cannot mark a new visit creation as failed', async () => {
  const previous = deferredResponse();
  const current = deferredResponse();
  await store().load(gateway({ 'GET /api/me/share-tokens': () => json([]) }).fetcher);
  const oldCreation = store().create(() => previous.promise);
  store().forgetCreated();
  const newCreation = store().create(() => current.promise);
  previous.reject(new Error('request failed'));
  await oldCreation;
  expect(store()).toMatchObject({ created: null, creating: true, createFailed: false });
  const created = { id: 'd', token: 'current-code', createdAt: a.createdAt };
  current.resolve(json(created, 201));
  await newCreation;
  expect(store()).toMatchObject({ created, creating: false, createFailed: false });
});

test('a failed create says so and shows no code', async () => {
  await store().create(gateway({ 'POST /api/me/share-tokens': () => json({}, 500) }).fetcher);
  expect(store()).toMatchObject({ created: null, creating: false, createFailed: true });
});

test('remove deletes that one row; a failed remove keeps the row and marks it; a code already gone counts as removed', async () => {
  let deleteStatus = 500;
  const { fetcher, calls } = gateway({ 'GET /api/me/share-tokens': () => json([a, b]),
    'DELETE /api/me/share-tokens/a': () => new Response(null, { status: deleteStatus }), 'DELETE /api/me/share-tokens/b': () => new Response(null, { status: 404 }) });
  await store().load(fetcher);
  expect(await store().remove('a', fetcher)).toBe(false);
  expect(store()).toMatchObject({ removing: null, removeFailed: 'a', list: { state: 'ready', tokens: [a, b] } });
  deleteStatus = 204;
  expect(await store().remove('a', fetcher)).toBe(true);
  expect(store()).toMatchObject({ removing: null, removeFailed: null, list: { state: 'ready', tokens: [b] } });
  expect(await store().remove('b', fetcher)).toBe(true);
  expect(store().list).toEqual({ state: 'ready', tokens: [] });
  expect(calls.filter(call => call.method === 'DELETE').map(call => call.url)).toEqual(['/api/me/share-tokens/a', '/api/me/share-tokens/a', '/api/me/share-tokens/b']);
});

test('removing the code just created also hides its secret', async () => {
  const created = { id: 'c', token: 'secret-code', createdAt: '2026-10-10T09:00:00.000Z' };
  const { fetcher } = gateway({ 'GET /api/me/share-tokens': () => json([]), 'POST /api/me/share-tokens': () => json(created, 201),
    'DELETE /api/me/share-tokens/c': () => new Response(null, { status: 204 }) });
  await store().load(fetcher);
  await store().create(fetcher);
  await store().remove('c', fetcher);
  expect(store().created).toBeNull();
  expect(store().list).toEqual({ state: 'ready', tokens: [] });
});

test('the Shortcut link comes from settings, https only; anything else is "coming soon"', async () => {
  const { loadShareShortcutUrl } = await import('./shareTokens');
  const settings = (body: Wire, status = 200) => gateway({ 'GET /api/config/settings': () => json(body, status) }).fetcher;
  expect(await loadShareShortcutUrl(settings({ shareShortcutUrl: 'https://www.icloud.com/shortcuts/abc' }))).toBe('https://www.icloud.com/shortcuts/abc');
  expect(await loadShareShortcutUrl(settings({ shareShortcutUrl: 'javascript:alert(1)' }))).toBeNull();
  expect(await loadShareShortcutUrl(settings({}))).toBeNull();
  expect(await loadShareShortcutUrl(settings({}, 500))).toBeNull();
});
