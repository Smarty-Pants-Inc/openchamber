import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

const reloadOpenCodeConfigurationCalls: unknown[][] = [];
const reloadOpenCodeConfiguration = async (...args: unknown[]) => {
  reloadOpenCodeConfigurationCalls.push(args);
};
const applyPendingOpenCodeRestartCalls: unknown[][] = [];
const applyPendingOpenCodeRestart = async (...args: unknown[]) => {
  applyPendingOpenCodeRestartCalls.push(args);
  return { ok: true, requiresManualRestart: false };
};
const clearPendingRestartCalls: unknown[][] = [];
const clearPendingRestart = (...args: unknown[]) => {
  clearPendingRestartCalls.push(args);
};
const setShowOpenCodeRestartConfirm = () => undefined;
const toast = {
  error: () => undefined,
  success: () => undefined,
  warning: () => undefined,
};

type PendingRestartState = {
  changes: Array<{ id: string; scope: string; recordedAt: number }>;
  isApplying: boolean;
  clear: () => void;
};

let pendingRestartState: PendingRestartState;
let showOpenCodeRestartConfirm = false;

const usePendingOpenCodeRestartStore = Object.assign(
  <T,>(selector: (state: PendingRestartState) => T): T => selector(pendingRestartState),
  { getState: (): PendingRestartState => pendingRestartState },
);

mock.module('@/components/ui', () => ({ toast }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) => open ? <>{children}</> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));
mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));
mock.module('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        'settings.view.actions.reloadOpenCode': 'Reload Smarty Code',
        'settings.view.actions.reloadOpenCodeTooltip': 'Restart Smarty Code and reload its configuration.',
        'settings.view.actions.applyAndRestartOpenCode': 'Apply & Restart',
        'settings.view.actions.applyAndRestartOpenCodeTooltipSingle': 'Apply 1 pending configuration change and restart Smarty Code.',
        'settings.view.actions.applyAndRestartOpenCodeTooltipPlural': 'Apply {count} pending configuration changes and restart Smarty Code.',
        'settings.view.pendingRestart.applying': 'Restarting...',
        'settings.view.pendingRestart.applied': 'Smarty Code restarted with pending configuration changes.',
        'settings.view.pendingRestart.applyFailed': 'Failed to apply configuration changes.',
        'settings.view.pendingRestart.manualRestartRequired': 'A manual restart is required.',
        'settings.view.pendingRestart.confirm.title': 'Apply & restart?',
        'settings.view.pendingRestart.confirm.description': 'Restarting Smarty Code will stop any running chats.',
        'settings.view.pendingRestart.confirm.cancel': 'Cancel',
        'settings.view.pendingRestart.confirm.dontShowAgain': "Don't show this again",
      };
      return (messages[key] ?? key).replace('{count}', String(params?.count ?? ''));
    },
  }),
}));
mock.module('@/lib/opencode/deferredRestart', () => ({ applyPendingOpenCodeRestart }));
mock.module('@/stores/useAgentsStore', () => ({ reloadOpenCodeConfiguration }));
mock.module('@/stores/usePendingOpenCodeRestartStore', () => ({
  selectPendingOpenCodeRestartCount: (state: PendingRestartState) => state.changes.length,
  usePendingOpenCodeRestartStore,
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: {
    showOpenCodeRestartConfirm: boolean;
    setShowOpenCodeRestartConfirm: typeof setShowOpenCodeRestartConfirm;
  }) => T): T => selector({ showOpenCodeRestartConfirm, setShowOpenCodeRestartConfirm }),
}));

// This focused rendering test imports after mocks so the footer uses its deterministic runtime collaborators.
const { OpenCodeReloadFooterAction } = await import('./OpenCodeReloadFooterAction');

type MountedFooter = {
  host: HTMLDivElement;
  root: Root;
  restore: () => Promise<void>;
};

const mountFooter = async (): Promise<MountedFooter> => {
  const windowInstance = new Window({ url: 'http://localhost/' });
  windowInstance.document.write('<!doctype html><html><body></body></html>');
  windowInstance.document.close();

  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const installGlobal = (name: string, value: unknown) => {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  installGlobal('window', windowInstance);
  installGlobal('document', windowInstance.document);
  installGlobal('navigator', windowInstance.navigator);
  for (const name of ['Document', 'Element', 'HTMLElement', 'Node', 'Text', 'Event', 'EventTarget', 'HTMLButtonElement']) {
    const value = windowInstance[name as keyof Window];
    if (value === undefined) throw new Error(`happy-dom global ${name} is unavailable`);
    installGlobal(name, value);
  }
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<OpenCodeReloadFooterAction />);
    await Promise.resolve();
  });

  return {
    host,
    root,
    restore: async () => {
      await act(async () => root.unmount());
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

describe('OpenCodeReloadFooterAction', () => {
  beforeEach(() => {
    reloadOpenCodeConfigurationCalls.length = 0;
    applyPendingOpenCodeRestartCalls.length = 0;
    clearPendingRestartCalls.length = 0;
    pendingRestartState = { changes: [], isApplying: false, clear: clearPendingRestart };
    showOpenCodeRestartConfirm = false;
  });

  test('reloads Smarty Code from the bottom Settings action when no changes are pending', async () => {
    const mounted = await mountFooter();
    try {
      const button = mounted.host.querySelector<HTMLButtonElement>('button[title="Restart Smarty Code and reload its configuration."]');
      expect(button?.textContent).toBe('Reload Smarty Code');
      expect(button?.getAttribute('aria-label')).toBe('Restart Smarty Code and reload its configuration.');

      await act(async () => {
        button?.click();
        await Promise.resolve();
      });

      expect(reloadOpenCodeConfigurationCalls).toEqual([[
        {
          message: 'Restarting...',
          mode: 'projects',
          scopes: ['all'],
        },
      ]]);
      expect(clearPendingRestartCalls).toEqual([[]]);
    } finally {
      await mounted.restore();
    }
  });

  test('applies pending Settings changes through the restart action', async () => {
    pendingRestartState = {
      changes: [{ id: 'agents:1', scope: 'agents', recordedAt: 0 }],
      isApplying: false,
      clear: clearPendingRestart,
    };
    const mounted = await mountFooter();
    try {
      const button = mounted.host.querySelector<HTMLButtonElement>('button[title="Apply 1 pending configuration change and restart Smarty Code."]');
      expect(button?.textContent).toBe('1Apply & Restart');

      await act(async () => {
        button?.click();
        await Promise.resolve();
      });

      expect(applyPendingOpenCodeRestartCalls).toEqual([[{ message: 'Restarting...' }]]);
      expect(reloadOpenCodeConfigurationCalls).toEqual([]);
    } finally {
      await mounted.restore();
    }
  });
});
