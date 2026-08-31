import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SessionBackendPolicyError,
  assertSessionSendBackend,
  foldSessionBackendHistory,
} from '../../web/server/lib/openchamber-sessions/session-backend-policy.js';
import { sessionBackendPolicyStatus as webStatus } from '../../web/server/lib/openchamber-sessions/routes.js';
import { sessionBackendPolicyStatus as vscodeStatus } from './bridge-session-runtime';

describe('session backend policy status parity', () => {
  test('maps shared policy conflicts to 409 in both runtimes', () => {
    let error;
    try {
      assertSessionSendBackend({ backend: null, providerID: 'omp' });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof SessionBackendPolicyError);

    assert.equal(webStatus(error), 409);
    assert.equal(vscodeStatus(error), 409);
  });

  test('maps incomplete pages and stalled cursors to 502 in both runtimes', async () => {
    let error;
    try {
      await foldSessionBackendHistory(async () => ({ records: null, nextCursor: null }));
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof SessionBackendPolicyError);
    assert.equal(webStatus(error), 502);
    assert.equal(vscodeStatus(error), 502);
  });

  test('leaves runtime transport failures to each adapter', () => {
    const error = new Error('transport failed');
    assert.equal(webStatus(error), null);
    assert.equal(vscodeStatus(error), null);
  });
});
