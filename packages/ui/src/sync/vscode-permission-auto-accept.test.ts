import { expect, test } from 'bun:test';
import type { PermissionRequest } from '@opencode-ai/sdk/v2/client';
import { createVSCodePermissionAutoAcceptRuntime, processVSCodePermissionAutoAccept, processVSCodeReconciledPermissionAutoAccept, reconcileVSCodePendingPermissions } from './vscode-permission-auto-accept';

const permission: PermissionRequest = { id: 'pending', sessionID: 'root', permission: 'bash', patterns: ['echo test'], metadata: {}, always: [] };

test('actual VS Code responder refuses stored-enabled, live, bootstrap, reconnect and retry paths without calling dependencies', async () => {
  let calls = 0;
  const runtime = createVSCodePermissionAutoAcceptRuntime({
    getPolicy: () => { calls++; return { root: true }; },
    getSessions: () => { calls++; return new Map(); },
    getSession: async () => { calls++; throw new Error('must not load lineage'); },
    getKnownPendingPermissions: () => { calls++; return [permission]; },
    listPendingPermissions: async () => { calls++; return [permission]; },
    getPermissionState: async () => { calls++; return 'ok'; },
    reply: async () => { calls++; },
    wait: async () => { calls++; },
  });
  for (const verifyPending of [true, false]) {
    expect(await runtime.processPermission(permission, '/project', { verifyPending })).toBe(false);
  }
  await Promise.all([runtime.reconcilePending(), runtime.reconcilePending('/project')]);
  expect(calls).toBe(0);
});

test('actual production exported foreground entrypoints leave cards visible and never reconcile replies', async () => {
  expect(await processVSCodePermissionAutoAccept(permission, '/project')).toBe(false);
  expect(await processVSCodeReconciledPermissionAutoAccept(permission, '/project')).toBe(false);
  await reconcileVSCodePendingPermissions('/project');
});
