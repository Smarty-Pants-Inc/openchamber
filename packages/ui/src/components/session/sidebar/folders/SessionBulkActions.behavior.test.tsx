import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { installHookTestDom } from '../test-utils/testDom';

type BulkActionCapture = {
  onCreateFolderAndMove: () => void;
};

let bulkActionCapture: BulkActionCapture | null = null;

mock.module('./BulkActionBar', () => ({
  BulkActionBar: (props: BulkActionCapture) => {
    bulkActionCapture = props;
    return null;
  },
}));

mock.module('./ConfirmDialogs', () => ({
  BulkSessionDeleteConfirmDialog: () => null,
}));

const { SessionBulkActions } = await import('./SessionBulkActions');

describe('SessionBulkActions public behavior', () => {
  test('moves the selected sessions into a newly created folder while a row edit is active', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    const renameRequests: Array<{ scopeKey: string; folder: { id: string; name: string } }> = [];
    const moved: Array<{ scopeKey: string; folderId: string; ids: string[] }> = [];
    useSessionFoldersStore.setState({
      foldersMap: {},
      addSessionsToFolder: (scopeKey, folderId, ids) => moved.push({ scopeKey, folderId, ids }),
    });
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(['session-a']),
      scopeKey: 'project-a',
      anchorId: 'session-a',
    });
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value },
    });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionBulkActions
            getFolderScopesForProject={() => [{ scopeKey: '/workspace', directory: '/workspace' }]}
            isInlineEditing
            startFolderRename={(scopeKey, folder) => renameRequests.push({ scopeKey, folder })}
          />
        </I18nProvider>,
      ));
      expect(bulkActionCapture).not.toBeNull();

      await act(async () => bulkActionCapture?.onCreateFolderAndMove());
       const createdFolder = useSessionFoldersStore.getState().foldersMap['/workspace']?.[0];
       expect(createdFolder?.name).toBe('New folder');
       expect(renameRequests).toEqual([{ scopeKey: '/workspace', folder: createdFolder }]);
       expect(moved).toEqual([{ scopeKey: '/workspace', folderId: createdFolder?.id ?? '', ids: ['session-a'] }]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      if (cssDescriptor) Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(globalThis, 'CSS');
      bulkActionCapture = null;
      dom.restore();
    }
  });

  test('selects only manageable rows in the first manageable scope with Ctrl+A', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalSelection = useSessionMultiSelectStore.getState();
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(),
      scopeKey: null,
      anchorId: null,
    });
    const originalCss = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value },
    });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionBulkActions
            getFolderScopesForProject={() => []}
            isInlineEditing={false}
            startFolderRename={() => undefined}
          />
        </I18nProvider>,
      ));

      const row = (id: string, scope: string, manageable: boolean) => ({
        getAttribute: (name: string) => ({
          'data-session-row': id,
          'data-session-scope': scope,
          'data-session-manage-retention': manageable ? '1' : '0',
        })[name] ?? null,
      }) as Element;
      Object.defineProperty(document, 'querySelectorAll', {
        configurable: true,
        value: () => [
          row('read-only-b', 'project-b', false),
          row('mutable-a', 'project-a', true),
          row('mutable-b', 'project-b', true),
        ],
      });

      const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent || '');
      const keydown = new Event('keydown', { bubbles: true });
      Object.defineProperties(keydown, {
        key: { value: 'a' },
        ctrlKey: { value: !isMac },
        metaKey: { value: isMac },
      });
      await act(async () => window.dispatchEvent(keydown));

      expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['mutable-a']);
      expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project-a');
    } finally {
      await act(async () => root.unmount());
      useSessionMultiSelectStore.setState(originalSelection, true);
      bulkActionCapture = null;
      if (originalCss) Object.defineProperty(globalThis, 'CSS', originalCss);
      else Reflect.deleteProperty(globalThis, 'CSS');
      dom.restore();
    }
  });
});
