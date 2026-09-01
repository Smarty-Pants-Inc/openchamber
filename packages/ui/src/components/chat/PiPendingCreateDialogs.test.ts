import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionRequest, PermissionResponse } from '@/types/permission';
import type { PendingPiCreate, PendingPiCreateDialog, PiCreateDialogReply } from '@/sync/pi-pending-create';

type PermissionCardCall = {
  permission: PermissionRequest;
  onRespond?: (response: PermissionResponse) => Promise<void>;
};

type PendingCreateStoreState = {
  pendingCreates: Record<string, PendingPiCreate>;
};

let pendingCreateStoreState: PendingCreateStoreState = { pendingCreates: {} };
const permissionCardCalls: PermissionCardCall[] = [];
const replies: Array<{ correlation: string; dialogID: string; reply: PiCreateDialogReply }> = [];
let dialogProps: { open?: boolean; modal?: boolean; disablePointerDismissal?: boolean } | null = null;
let popupProps: { ariaLabel?: string; initialFocus?: boolean } | null = null;
let portalRenderCount = 0;

mock.module('@/sync/pi-pending-create', () => ({
  replyToPendingPiCreateDialog: async (correlation: string, dialogID: string, reply: PiCreateDialogReply) => {
    replies.push({ correlation, dialogID, reply });
  },
  usePiPendingCreateStore: <T,>(selector: (state: PendingCreateStoreState) => T): T => (
    selector(pendingCreateStoreState)
  ),
}));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, ...props }: { children?: React.ReactNode; open?: boolean; modal?: boolean; disablePointerDismissal?: boolean }) => {
    dialogProps = props;
    return React.createElement(React.Fragment, null, children);
  },
}));
mock.module('@base-ui/react/dialog', () => ({
  Dialog: {
    Portal: ({ children }: { children?: React.ReactNode }) => {
      portalRenderCount += 1;
      return React.createElement(React.Fragment, null, children);
    },
    Backdrop: ({ className }: { className?: string }) => React.createElement('div', { className }),
    Popup: ({ children, 'aria-label': ariaLabel, initialFocus }: { children?: React.ReactNode; 'aria-label'?: string; initialFocus?: boolean }) => {
      popupProps = { ariaLabel, initialFocus };
      return React.createElement(React.Fragment, null, children);
    },
  },
}));
mock.module('./PermissionCard', () => ({
  PermissionCard: (props: PermissionCardCall) => {
    permissionCardCalls.push(props);
    return null;
  },
}));
mock.module('./QuestionCard', () => ({ QuestionCard: () => null }));
// The card modules load browser-only workers, so mock them before loading this presentation boundary.
const { PiPendingCreateDialogs, toPiPendingCreatePermission, toPiPendingCreateQuestion } = await import('./PiPendingCreateDialogs');

beforeEach(() => {
  pendingCreateStoreState = { pendingCreates: {} };
  permissionCardCalls.length = 0;
  replies.length = 0;
  dialogProps = null;
  popupProps = null;
  portalRenderCount = 0;
});

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

  test('shows one deterministic active prompt with scoped keyboard identity', async () => {
    const activeDialog: Extract<PendingPiCreateDialog, { method: 'confirm' }> = {
      type: 'extension_ui_request',
      id: 'confirm-1',
      method: 'confirm',
      title: 'Active prompt',
      message: 'The extension needs confirmation.',
      observedAt: 1,
    };
    const queuedDialog: Extract<PendingPiCreateDialog, { method: 'confirm' }> = {
      ...activeDialog,
      title: 'Queued prompt',
      observedAt: 2,
    };
    pendingCreateStoreState = {
      pendingCreates: {
        'correlation-b': { ...pending, correlation: 'correlation-b', dialogs: [queuedDialog] },
        'correlation-a': { ...pending, correlation: 'correlation-a', dialogs: [activeDialog] },
      },
    };

    const markup = renderToStaticMarkup(React.createElement(PiPendingCreateDialogs));

    expect(dialogProps).toEqual({ open: true, modal: true, disablePointerDismissal: true });
    expect(portalRenderCount).toBe(1);
    expect(popupProps).toEqual({ ariaLabel: 'Active prompt', initialFocus: true });
    expect(markup.match(/z-\[70\]/g)).toHaveLength(2);
    expect(permissionCardCalls.map(({ permission }) => permission.id)).toEqual(['correlation-a:confirm-1']);
    expect(pendingCreateStoreState.pendingCreates['correlation-b']?.dialogs).toEqual([queuedDialog]);

    const activeResponse = permissionCardCalls[0]?.onRespond;
    if (!activeResponse) throw new Error('Expected an active permission response handler');
    await activeResponse('once');

    expect(replies).toEqual([{
      correlation: 'correlation-a',
      dialogID: 'confirm-1',
      reply: { confirmed: true },
    }]);

    permissionCardCalls.length = 0;
    pendingCreateStoreState = {
      pendingCreates: {
        'correlation-b': { ...pending, correlation: 'correlation-b', dialogs: [queuedDialog] },
      },
    };
    renderToStaticMarkup(React.createElement(PiPendingCreateDialogs));

    expect(popupProps).toEqual({ ariaLabel: 'Queued prompt', initialFocus: true });
    expect(permissionCardCalls.map(({ permission }) => permission.id)).toEqual(['correlation-b:confirm-1']);
    const queuedResponse = permissionCardCalls[0]?.onRespond;
    if (!queuedResponse) throw new Error('Expected a queued permission response handler');
    await queuedResponse('once');

    expect(replies).toEqual([
      {
        correlation: 'correlation-a',
        dialogID: 'confirm-1',
        reply: { confirmed: true },
      },
      {
        correlation: 'correlation-b',
        dialogID: 'confirm-1',
        reply: { confirmed: true },
      },
    ]);
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
