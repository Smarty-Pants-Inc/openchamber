import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PendingPiCreate, PendingPiCreateDialog } from '@/sync/pi-pending-create';

mock.module('./PermissionCard', () => ({ PermissionCard: () => null }));
mock.module('./QuestionCard', () => ({ QuestionCard: () => null }));
// The card modules load browser-only workers, so mock them before loading this presentation boundary.
const { toPiPendingCreatePermission, toPiPendingCreateQuestion } = await import('./PiPendingCreateDialogs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf-8');
const vscodeAppSource = readFileSync(join(__dirname, '..', '..', 'apps', 'VSCodeApp.tsx'), 'utf-8');
const mobileAppSource = readFileSync(join(__dirname, '..', '..', 'apps', 'MobileApp.tsx'), 'utf-8');
const miniChatAppSource = readFileSync(join(__dirname, '..', '..', 'apps', 'ElectronMiniChatApp.tsx'), 'utf-8');
const mainLayoutSource = readFileSync(join(__dirname, '..', 'layout', 'MainLayout.tsx'), 'utf-8');
const chatContainerSource = readFileSync(join(__dirname, 'ChatContainer.tsx'), 'utf-8');

const pending: PendingPiCreate = {
  pendingCreateID: 'pending-1',
  serverPendingCreateID: 'pending-1',
  runtimeKey: 'runtime-a',
  directory: '/workspace/pi',
  correlation: 'correlation-1',
  dialogs: [],
  resolvedDialogIDs: [],
  replyingDialogIDs: [],
};

describe('Pi pending create dialog presentation', () => {
  test('projects a confirm request into the existing permission card shape', () => {
    const dialog: Extract<PendingPiCreateDialog, { method: 'confirm' }> = {
      type: 'extension_ui_request',
      id: 'confirm-1',
      method: 'confirm',
      title: 'Use this directory?',
      message: 'The extension needs confirmation.',
      observedAt: 1,
    };

    expect(toPiPendingCreatePermission(pending, dialog)).toEqual({
      id: 'confirm-1',
      sessionID: 'pending-1',
      permission: 'Use this directory?',
      patterns: [],
      always: [],
      metadata: { description: 'The extension needs confirmation.' },
    });
  });

  test('projects a selection request into the existing question card shape', () => {
    const dialog: Extract<PendingPiCreateDialog, { method: 'select' }> = {
      type: 'extension_ui_request',
      id: 'select-1',
      method: 'select',
      title: 'Choose a mode',
      options: ['Safe', 'Fast'],
      observedAt: 1,
    };

    expect(toPiPendingCreateQuestion(pending, dialog)).toEqual({
      id: 'select-1',
      sessionID: 'pending-1',
      questions: [{
        header: 'Choose a mode',
        question: 'Choose a mode',
        options: [
          { label: 'Safe', description: '' },
          { label: 'Fast', description: '' },
        ],
      }],
    });
  });

  test('mounts exactly one global presenter in every session-creating shell', () => {
    expect(appSource.match(/<PiPendingCreateDialogs \/>/g)).toHaveLength(1);
    expect(appSource.match(/\{pendingCreateDialogs\}/g)).toHaveLength(2);
    expect(vscodeAppSource.match(/<PiPendingCreateDialogs \/>/g)).toHaveLength(1);
    expect(vscodeAppSource.match(/\{pendingCreateDialogs\}/g)).toHaveLength(2);
    expect(mobileAppSource.match(/<PiPendingCreateDialogs \/>/g)).toHaveLength(1);
    expect(miniChatAppSource.match(/<PiPendingCreateDialogs \/>/g)).toHaveLength(1);
    expect(mainLayoutSource).not.toContain('<PiPendingCreateDialogs />');
    expect(chatContainerSource).not.toContain('<PiPendingCreateDialogs />');
  });
});
