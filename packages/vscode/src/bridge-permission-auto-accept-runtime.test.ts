import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePermissionAutoAcceptBridgeMessage } from './bridge-permission-auto-accept-runtime';

describe('hard-disabled VS Code permission policy receiver', () => {
  test('GET and every set refuse without reading, changing or broadcasting stored policy', async () => {
    const stored = { sessions: { root: true, child: false }, revision: 17 };
    const before = JSON.stringify(stored);
    let reads = 0, writes = 0, broadcasts = 0;
    const context = { globalState: {
      get: () => { reads++; return stored; },
      update: async () => { writes++; },
    } };
    const dependencies = { broadcast: async () => { broadcasts++; } };
    for (const type of ['api:permission-auto-accept:get', 'api:permission-auto-accept:set']) {
      for (const enabled of [true, false, 'yes', null]) {
        const result = await handlePermissionAutoAcceptBridgeMessage({ id: 'request', type, payload: { sessionId: 'root', enabled } }, context, dependencies);
        assert.equal(result?.success, false);
        assert.match(result?.error ?? '', /unsupported/i);
        assert.deepEqual(result?.data, { supported: false, status: 501 });
      }
    }
    assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(broadcasts, 0);
    assert.equal(JSON.stringify(stored), before);
  });

  test('missing context cannot open a fallback and manual permission proxy requests still delegate', async () => {
    const unavailable = await handlePermissionAutoAcceptBridgeMessage({ id: 'get', type: 'api:permission-auto-accept:get' });
    assert.equal(unavailable?.success, false);
    assert.match(unavailable?.error ?? '', /unsupported/i);
    for (const reply of ['once', 'always', 'reject']) {
      assert.equal(await handlePermissionAutoAcceptBridgeMessage({
        id: 'manual', type: 'api:proxy', payload: { method: 'POST', path: '/permission/manual/reply', bodyBase64: Buffer.from(JSON.stringify({ reply })).toString('base64') },
      }), null);
    }
  });
});
