import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'vitest';
import { createResponsePolicyMiddleware } from './http-response-policy.js';
import { fixture, humanFixture } from './1190-response-policy-fixture.js';

const headers = [['Content-Security-Policy', "script-src 'none'"], ['Cache-Control', 'private, no-store'], ['Vary', 'Cookie']];
const unavailable = result => {
  assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(result.body), { error: 'Response policy unavailable' });
};

test('undefined installs nothing, makes zero auth lookups and leaves stock static/cache/preview bytes intact', async () => {
  let lookups = 0;
  const f = await fixture(undefined, () => { lookups++; throw new Error('must never resolve auth'); });
  try {
    assert.equal(f.middleware, null);
    const page = await f.call();
    assert.equal(page.body, f.html); assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['content-security-policy'], undefined);
    const asset = await f.call('/assets/inert.js');
    assert.equal(asset.headers['cache-control'], 'public, max-age=0'); assert.ok(asset.headers.etag);
    assert.equal((await f.call('/assets/inert.js', { 'If-None-Match': asset.headers.etag })).status, 304);
    assert.equal((await f.call('/manifest.webmanifest')).headers['cache-control'], 'no-store, must-revalidate');
    assert.equal((await f.call(f.preview)).headers['content-security-policy'], 'sandbox allow-scripts');
    assert.equal(lookups, 0);
  } finally { await f.close(); }
});

test('real static and manifest factories retain validated private,no-store on HTML, worker, assets and 404', async () => {
  let lookups = 0;
  const f = await fixture(() => headers, () => { lookups++; });
  try {
    for (const route of ['/', '/sw.js', '/assets/inert.js', '/assets/missing.js', '/manifest.webmanifest']) {
      const result = await f.call(route);
      assert.equal(result.headers['content-security-policy'], "script-src 'none'");
      assert.equal(result.headers['cache-control'], 'private, no-store');
    }
    assert.equal(lookups, 0, 'Inert policies do not inspect auth');
  } finally { await f.close(); }
});

test('all three actual preview/raw CSP writers append independent sandbox policy exactly once', async () => {
  const f = await fixture(() => headers);
  try {
    for (const [route, sandbox] of [[f.preview, 'sandbox allow-scripts'],
      [`/api/fs/serve/${f.directory}/index.html`, 'sandbox allow-scripts'],
      [`/api/fs/raw?path=${encodeURIComponent(`${f.directory}/raw.txt`)}`, 'sandbox']]) {
      const result = await f.call(route);
      assert.equal(result.status, 200, route);
      assert.equal(result.headers['content-security-policy'], `script-src 'none', ${sandbox}`);
      assert.equal(result.headers['cache-control'], 'private, no-store');
    }
  } finally { await f.close(); }
});

test('existing CSP and Vary remain independent before and after the early hook', async () => {
  const f = await fixture(() => headers, undefined, (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'"); res.setHeader('Vary', 'Accept');
  });
  try {
    const result = await f.call(f.preview);
    assert.equal(result.headers['content-security-policy'], "default-src 'self', script-src 'none', sandbox allow-scripts");
    assert.equal(result.headers.vary, 'Accept, Cookie');
  } finally { await f.close(); }
});

test('auth errors fail closed even if caught or not awaited by the trusted callback', async () => {
  for (const callback of [async (_req, context) => { try { await context.getHumanSession(); } catch { /* The callback deliberately catches the lookup error. */ } return headers; },
    (_req, context) => { void context.getHumanSession().catch(() => {}); return headers; }]) {
    const f = await fixture(callback, () => { throw new Error('private auth failure'); });
    try {
      const result = await f.call(); unavailable(result);
      assert.equal(result.headers['content-security-policy'], undefined); assert.equal(f.downstream(), 0);
    } finally { await f.close(); }
  }
});

test('real Better Auth expiry and deletion return null without exposing cookies, tokens or user fields', async () => {
  const person = await humanFixture();
  const observations = [];
  const f = await fixture(async (_req, context) => { observations.push(await context.getHumanSession()); return []; }, person.human.resolve);
  try {
    await f.call('/', { Cookie: person.headers.cookie });
    assert.equal(observations.at(-1).id, person.session.id);
    await person.adapter.updateSession(person.session.token, { expiresAt: new Date(Date.now() - 1000) });
    await f.call('/', { Cookie: person.headers.cookie }); assert.equal(observations.at(-1), null);
    await person.adapter.deleteSession(person.session.token);
    await f.call('/', { Cookie: person.headers.cookie }); assert.equal(observations.at(-1), null);
  } finally { await f.close(); person.close(); }
});

test('unconfigured or absent session is null and each request memoizes one lazy resolution', async () => {
  for (const value of [null]) {
    let lookups = 0;
    const f = await fixture(async (_req, context) => {
      const first = context.getHumanSession(); assert.equal(first, context.getHumanSession());
      assert.equal(await first, null); return [];
    }, async () => { lookups++; return value; });
    try { await f.call(); await f.call(); assert.equal(lookups, 2); } finally { await f.close(); }
  }
  const f = await fixture(async (_req, context) => { assert.equal(await context.getHumanSession(), null); return []; });
  try { assert.equal((await f.call()).status, 200); } finally { await f.close(); }
});

test('policy-bearing conditional assets return complete 200 while stock validators keep their 304 control', async () => {
  const f = await fixture(() => headers);
  try {
    const asset = await f.call('/assets/inert.js');
    for (const condition of [{ 'If-None-Match': asset.headers.etag }, { 'If-None-Match': '*' },
      { 'If-Modified-Since': asset.headers['last-modified'] }]) {
      const result = await f.call('/assets/inert.js', condition);
      assert.equal(result.status, 200); assert.equal(result.body, '/* inert asset */');
      assert.equal(result.headers['cache-control'], 'private, no-store');
      assert.equal((await f.call('/assets/inert.js', condition, 'HEAD')).status, 200);
    }
  } finally { await f.close(); }
});

test('non-null malformed authenticated metadata fails with sanitized 503 before any policy headers', async () => {
  for (const value of [{}, undefined, { session: { id: 'inert', createdAt: 'invalid', expiresAt: new Date(Date.now() + 1000) } },
    { session: { id: 'inert', createdAt: null, expiresAt: new Date(Date.now() + 1000) } }]) {
    const f = await fixture(async (_req, context) => { await context.getHumanSession(); return headers; }, async () => value);
    try {
      const result = await f.call(); unavailable(result);
      assert.equal(result.headers['content-security-policy'], undefined); assert.equal(f.downstream(), 0);
    } finally { await f.close(); }
  }
});

test('concurrent held callbacks abort on response close and cause zero late headers or downstream admission', async () => {
  const held = [];
  let entered;
  const enteredBoth = new Promise(resolve => { entered = resolve; });
  const f = await fixture((_req, context) => new Promise(resolve => {
    held.push({ context, release: resolve }); if (held.length === 2) entered();
  }));
  const requests = [];
  try {
    for (let index = 0; index < 2; index++) {
      const req = http.get({ host: '127.0.0.1', port: f.server.address().port, path: '/' });
      req.on('error', () => {}); requests.push(req);
    }
    await enteredBoth;
    const responses = f.responses();
    const closed = responses.map(res => once(res, 'close'));
    requests.forEach(req => req.destroy()); await Promise.all(closed);
    for (const pending of held) { assert.ok(pending.context.signal.aborted); pending.release([['X-Late', 'forbidden']]); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.downstream(), 0);
    for (const res of responses) { assert.equal(res.getHeader('X-Late'), undefined); assert.ok(res.destroyed); }
  } finally { requests.forEach(req => req.destroy()); await f.close(); }
}, 10000);

test('hung auth shares the callback deadline and later settlement cannot write or admit static routes', async () => {
  let release, signal;
  const f = await fixture(async (_req, context) => { signal = context.signal; await context.getHumanSession(); return headers; },
    () => new Promise(resolve => { release = resolve; }));
  try {
    const started = Date.now(); const result = await f.call(); unavailable(result);
    assert.ok(Date.now() - started < 6500); assert.ok(signal.aborted); assert.equal(f.downstream(), 0);
    release(null); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.response().getHeader('Content-Security-Policy'), undefined);
  } finally { await f.close(); }
}, 8000);

test('validate the whole result before any write, copy trusted tuples, append CSP/Vary, reject invalid hook shape', async () => {
  for (const result of [undefined, [['X-Early', 'forbidden'], ['Invalid Header', 'bad']],
    [['Cache-Control', 'public, max-age=100']], [['Vary', 'not a field']], [['X-Early', 'a\r\nb']]]) {
    const f = await fixture(() => result);
    try { const response = await f.call(); unavailable(response); assert.equal(response.headers['x-early'], undefined); }
    finally { await f.close(); }
  }
  for (const invalid of [null, {}, 'invalid']) assert.throws(() => createResponsePolicyMiddleware(invalid), /responsePolicy must be a function/);
  const f = await fixture(() => [['Content-Security-Policy', "default-src 'self'"], ['Vary', 'Cookie'], ['Vary', 'Origin']]);
  try {
    const result = await f.call(); assert.equal(result.headers.vary, 'Cookie, Origin');
    assert.equal(result.headers['content-security-policy'], "default-src 'self'");
  } finally { await f.close(); }
});
