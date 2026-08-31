import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPermissionApprovalSubmenu } from './tray-permission-menu.mjs';

const labels = (canAlwaysAllow) => buildPermissionApprovalSubmenu({
  id: 'permission-1',
  sessionId: 'session-1',
  directory: '/tmp/project',
  canAlwaysAllow,
}, () => {}).map((item) => item.label).filter(Boolean);

test('omits Allow always for one-shot permission requests', () => {
  assert.deepEqual(labels(false), ['Allow once', 'Deny', 'Open in app']);
});

test('shows Allow always only for reusable permission requests', () => {
  assert.deepEqual(labels(true), ['Allow once', 'Allow always', 'Deny', 'Open in app']);
});
