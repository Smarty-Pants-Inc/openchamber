import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixture } from './1190-response-policy-fixture.js';

const probe = ['X-Policy-Probe', 'present'];

test('quoted no-store text is not a directive: refuse before policy headers or downstream', async () => {
  const f = await fixture(() => [probe, ['Cache-Control', 'private, max-age=3600, extension="x, no-store, y"']]);
  try {
    const response = await f.call();
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'Response policy unavailable' });
    assert.equal(response.headers['x-policy-probe'], undefined);
    assert.equal(f.downstream(), 0);
  } finally { await f.close(); }
});

for (const value of ['private, no-store, extension="x, public, y"',
  'private, no-store, extension="x\\", public, y"', 'private, no-store, extension="x\\\\, public, y"']) {
  test(`quoted extension/quoted-pair commas are preserved: ${value}`, async () => {
    const f = await fixture(() => [probe, ['Cache-Control', value]]);
    try {
      const response = await f.call();
      assert.equal(response.status, 200); assert.equal(response.body, f.html);
      assert.equal(response.headers['x-policy-probe'], 'present');
      assert.equal(response.headers['cache-control'], value);
      assert.equal(f.downstream(), 1);
    } finally { await f.close(); }
  });
}

for (const value of ['private, no-store, extension="unterminated',
  'private, no-store, extension="trailing\\', 'private, no-store, public="x, y"',
  'private, no-store, s-maxage="x, y"']) {
  test(`malformed quote or genuine forbidden directive refuses before all headers: ${value}`, async () => {
    const f = await fixture(() => [probe, ['Cache-Control', value]]);
    try {
      const response = await f.call(); assert.equal(response.status, 503);
      assert.equal(response.headers['x-policy-probe'], undefined); assert.equal(f.downstream(), 0);
    } finally { await f.close(); }
  });
}

test('normalized Vary OWS publishes successful HTTP response and preserves earlier field', async () => {
  const f = await fixture(() => [probe, ['Vary', 'Cookie,\tOrigin']], undefined,
    (_req, res) => { res.setHeader('Vary', 'Accept'); });
  try {
    const response = await f.call();
    assert.equal(response.status, 200); assert.equal(response.body, f.html);
    assert.equal(response.headers['x-policy-probe'], 'present');
    assert.equal(response.headers.vary, 'Accept, Cookie, Origin');
    assert.equal(f.downstream(), 1);
  } finally { await f.close(); }
});
