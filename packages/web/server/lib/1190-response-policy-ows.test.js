import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixture } from './1190-response-policy-fixture.js';

const probe = ['X-Policy-Probe', 'present'];
for (const space of ['\u00a0', '\u1680', '\u2002', '\u202f', '\ufeff']) {
  for (const value of [`private, ${space}no-store, max-age=3600`,
    `private, no-store${space}, max-age=3600`, `${space}private, no-store`]) {
    test(`non-HTTP whitespace refuses before publication: ${JSON.stringify(value)}`, async () => {
      const f = await fixture(() => [probe, ['Cache-Control', value]]);
      try {
        const response = await f.call();
        assert.equal(response.status, 503);
        assert.deepEqual(JSON.parse(response.body), { error: 'Response policy unavailable' });
        assert.equal(response.headers['x-policy-probe'], undefined);
        assert.equal(response.headers['cache-control'], 'private, no-store');
        assert.equal(f.downstream(), 0);
      } finally { await f.close(); }
    });
  }
}

for (const value of [' \tprivate\t,\t no-store \t', 'private, no-store, extension="quoted\u00a0text"']) {
  test(`genuine SP/HTAB OWS and quoted obs-text preserve valid no-store: ${JSON.stringify(value)}`, async () => {
    const f = await fixture(() => [probe, ['Cache-Control', value]]);
    try {
      const response = await f.call();
      assert.equal(response.status, 200); assert.equal(response.body, f.html);
      assert.equal(response.headers['x-policy-probe'], 'present');
      // Node HTTP removes legal leading/trailing OWS on the wire, not Unicode within quoted text.
      assert.equal(response.headers['cache-control'], value.replace(/^[ \t]+|[ \t]+$/g, ''));
      assert.equal(f.downstream(), 1);
    } finally { await f.close(); }
  });
}

for (const value of ['Cookie,\u00a0Origin', 'Cookie,Origin\u00a0']) {
  test(`Vary does not silently normalize non-OWS: ${JSON.stringify(value)}`, async () => {
    const f = await fixture(() => [probe, ['Vary', value]]);
    try {
      const response = await f.call(); assert.equal(response.status, 503);
      assert.equal(response.headers['x-policy-probe'], undefined); assert.equal(f.downstream(), 0);
    } finally { await f.close(); }
  });
}
