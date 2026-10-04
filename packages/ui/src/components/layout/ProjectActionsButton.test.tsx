import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { CreateTerminalOptions, TerminalHandlers, TerminalStreamEvent } from '@/lib/api/types';
import { useTerminalStore } from '@/stores/useTerminalStore';
import type { OpenChamberProjectAction, ProjectRef, ProjectSetupPatch } from '@/lib/openchamberConfig';
import { ensureSharedSetupTrusted, getSharedTrustConfirmationSnapshot, settleSharedTrustConfirmation } from '@/lib/sharedTrustConfirmation';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { PROJECT_ACTIONS_UPDATED_EVENT } from '@/lib/projectActions';

const toastCalls = {
  error: new Array<string>(),
  info: new Array<string>(),
  success: new Array<string>(),
} satisfies { error: string[]; info: string[]; success: string[] };

const openContextPreviewCalls: Array<{ directory: string; url: string }> = [];
const openContextPanelTabCalls: Array<{ directory: string; mode: string; targetDirectory: string | null | undefined }> = [];
const openExternalCalls: string[] = [];
const detectedDevServer: MockedDetectedDevServer = { command: null, previewUrlHint: null };
const mockedDeviceInfo = { isMobile: false, isTablet: false, hasTouchOnlyPointer: false };
let effectiveDirectory = '/repo';
let sharedHash: string | null = null;
let trustedHash: string | null = null;
let configReadFails = false;
let useRealDetection = false;
let packageScripts: { dev: string } | null = null;
const trustPatches: ProjectSetupPatch[] = [];

const uiState = {
  terminalShell: 'zsh',
  terminalLoginShells: ['zsh'],
  setSettingsPage: () => undefined,
  setSettingsDialogOpen: () => undefined,
  setSettingsProjectsSelectedId: () => undefined,
  openContextPreview: (directory: string, url: string) => {
    openContextPreviewCalls.push({ directory, url });
  },
  openContextPanelTab: (directory: string, options: { mode: string; targetDirectory?: string | null }) => {
    openContextPanelTabCalls.push({ directory, mode: options.mode, targetDirectory: options.targetDirectory });
  },
  openContextSurface: () => undefined,
};

const useUiStoreMock = Object.assign(
  <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
  { getState: () => uiState },
);

const desktopSshState = { instances: [], load: async () => undefined };
const useDesktopSshStoreMock = <T,>(selector: (state: typeof desktopSshState) => T): T => selector(desktopSshState);

type SubscriptionRecord = {
  sessionId: string;
  handlers: TerminalHandlers;
  closed: number;
};

interface MockedActionsState {
  actions: OpenChamberProjectAction[];
}

interface MockedDetectedDevServer {
  command: string | null;
  previewUrlHint: string | null;
  actionId?: string;
}

const createCalls: CreateTerminalOptions[] = [];
const createdSessionId = (index: number): string => {
  const id = createCalls[index]?.sessionId;
  if (!id) throw new Error('missing requested terminal ID');
  return id;
};
const firstSessionId = () => createdSessionId(0);
const secondSessionId = () => createdSessionId(1);
const sendCalls: string[] = [];
const forceKillCalls: string[] = [];
const closeCalls: string[] = [];
const subscriptions: SubscriptionRecord[] = [];
let sessionCounter = 0;
const mockedActionsState: MockedActionsState = {
  actions: [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build' }],
};

const emitToSession = (sessionId: string, event: TerminalStreamEvent) => {
  subscriptions
    .filter((entry) => entry.sessionId === sessionId && entry.closed === 0)
    .forEach((entry) => entry.handlers.onEvent(event));
};

const terminal = {
  listSessions: async () => [],
  createSession: async (options: CreateTerminalOptions) => {
    createCalls.push(options);
    sessionCounter += 1;
    return {
      sessionId: options.sessionId ?? `session-${sessionCounter}`,
      cols: 80,
      rows: 24,
      status: 'running' as const,
      mode: 'command' as const,
      purpose: options.purpose,
    };
  },
  connect: (sessionId: string, handlers: SubscriptionRecord['handlers']) => {
    const record: SubscriptionRecord = { sessionId, handlers, closed: 0 };
    subscriptions.push(record);
    return {
      close: () => {
        record.closed += 1;
      },
    };
  },
  sendInput: async (sessionId: string, input: string) => {
    sendCalls.push(`${sessionId}:${input}`);
    queueMicrotask(() => {
      emitToSession(sessionId, { type: 'exit', sequence: 1, exitCode: 0, signal: null });
    });
  },
  resize: async () => undefined,
  updateAppearance: async () => undefined,
  close: async (sessionId: string) => {
    closeCalls.push(sessionId);
  },
  restartSession: async () => { throw new Error('not used'); },
  forceKill: async ({ sessionId }: { sessionId?: string }) => {
    forceKillCalls.push(sessionId ?? '');
  },
};

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DropdownMenuItem: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => React.createElement('button', { type: 'button', onClick, className }, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => { toastCalls.error.push(message); },
    info: (message: string) => { toastCalls.info.push(message); },
    success: (message: string) => { toastCalls.success.push(message); },
  },
}));
mock.module('@/components/icon/Icon', () => ({ Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }) }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ terminal, runtime: { isVSCode: false, platform: 'web' } }) }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => mockedDeviceInfo }));
// Modules under test import other desktop helpers too; keep the real ones.
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...desktop, isDesktopShell: () => false }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: useUiStoreMock }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' }, colors: { surface: { background: '#000' }, syntax: { base: { foreground: '#fff' } } } } }) }));
mock.module('@/stores/useDesktopSshStore', () => ({ useDesktopSshStore: useDesktopSshStoreMock }));
mock.module('@/lib/url', () => ({ openExternalUrl: async (url: string) => { openExternalCalls.push(url); } }));
mock.module('@/lib/openchamberConfig', () => ({
  getProjectActionsState: async () => mockedActionsState,
  getProjectSetup: async (_project: ProjectRef, options?: { strict?: boolean }) => {
    if (configReadFails && options?.strict) throw new Error('config unavailable');
    return {
    trust: { hash: sharedHash, trusted: sharedHash === null || trustedHash === sharedHash },
    setupWorktree: [],
    setupWorktreeWait: false,
    projectActions: mockedActionsState.actions.map((action) => ({ ...action, source: action.source ?? 'personal' })),
    projectActionsPrimaryId: null,
    draftStarters: [],
    shared: { status: sharedHash ? 'ok' : 'missing', path: '.openchamber/project.json', setupWorktree: [], setupWorktreeWait: null, projectActions: mockedActionsState.actions.filter((action) => action.source === 'shared'), draftStarters: [], plansDir: null },
    personal: { setupWorktree: [], setupWorktreeWait: null, setupWorktreeMode: 'append', projectActions: mockedActionsState.actions, projectActionsPrimaryId: null, draftStarters: [], hiddenSharedActionIds: [], sharedTrust: null },
    };
  },
  updateProjectSetup: async (_project: ProjectRef, patch: ProjectSetupPatch) => {
    trustPatches.push(patch);
    trustedHash = patch.sharedTrustHash ?? null;
    return true;
  },
}));
mock.module('@/lib/browser/announcedServers', () => ({ setAnnouncedDevServers: () => undefined }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => effectiveDirectory }));
const { detectDevServerCommand: realDetectDevServerCommand } = await import('@/lib/detectDevServer');
mock.module('@/lib/detectDevServer', () => ({
  detectDevServerCommand: async (directory: string, actions: OpenChamberProjectAction[], scripts: Record<string, string> | null) => (
    useRealDetection
      ? realDetectDevServerCommand(directory, actions, scripts)
      : detectedDevServer.command
        ? { command: detectedDevServer.command, actionId: detectedDevServer.actionId, previewUrlHint: detectedDevServer.previewUrlHint ?? undefined }
        : null
  ),
  readPackageJsonScripts: async () => packageScripts,
}));

const { ProjectActionsButton } = await import('./ProjectActionsButton');
const { getProjectSetup } = await import('@/lib/openchamberConfig');

describe('ProjectActionsButton lifecycle', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;
  const scheduledWindowTimeouts = new Map<ReturnType<Window['setTimeout']>, { delay: number; run: () => void }>();

  const runWindowTimeouts = async (delay: number) => {
    const matching = [...scheduledWindowTimeouts.entries()].filter(([, timeout]) => timeout.delay === delay);
    for (const [id] of matching) scheduledWindowTimeouts.delete(id);
    await act(async () => {
      for (const [, timeout] of matching) timeout.run();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    scheduledWindowTimeouts.clear();
    const originalSetTimeout = windowInstance.setTimeout.bind(windowInstance);
    const originalClearTimeout = windowInstance.clearTimeout.bind(windowInstance);
    windowInstance.setTimeout = (callback, delay = 0, ...args) => {
      const id = originalSetTimeout(() => undefined, 0);
      originalClearTimeout(id);
      scheduledWindowTimeouts.set(id, { delay, run: () => callback(...args) });
      return id;
    };
    windowInstance.clearTimeout = (id) => {
      if (id !== undefined) scheduledWindowTimeouts.delete(id);
    };
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useTerminalStore.getState().clearAll();
    createCalls.length = 0;
    sendCalls.length = 0;
    forceKillCalls.length = 0;
    closeCalls.length = 0;
    subscriptions.length = 0;
    toastCalls.error.length = 0;
    toastCalls.info.length = 0;
    toastCalls.success.length = 0;
    openContextPreviewCalls.length = 0;
    openContextPanelTabCalls.length = 0;
    openExternalCalls.length = 0;
    detectedDevServer.command = null;
    detectedDevServer.previewUrlHint = null;
    detectedDevServer.actionId = undefined;
    sharedHash = null;
    trustedHash = null;
    configReadFails = false;
    useRealDetection = false;
    packageScripts = null;
    trustPatches.length = 0;
    settleSharedTrustConfirmation('skip');
    configureRuntimeUrlResolver({ apiBaseUrl: '' });
    mockedDeviceInfo.isMobile = true;
    effectiveDirectory = '/repo';
    sessionCounter = 0;
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build' }];
  });

  afterEach(async () => {
    await act(async () => {
      settleSharedTrustConfirmation('skip');
      root.unmount();
    });
  });

  const renderButton = async ({
    projectPath = '/repo',
    directory = '/repo',
    compact = false,
  }: { projectPath?: string; directory?: string; compact?: boolean } = {}) => {
    await act(async () => {
      root.render(
        React.createElement(I18nProvider, null,
          React.createElement(ProjectActionsButton, {
            projectRef: { id: 'project-1', path: projectPath },
            directory,
            compact,
            allowMobile: true,
          }),
        ),
      );
    });
    await act(async () => { await Promise.resolve(); });
  };


  const click = async (button: HTMLButtonElement | null) => {
    if (!button) throw new Error('missing action button');
    await act(async () => { button.click(); });
  };
  const primary = () => host.querySelector('button');
  const createdCommand = () => {
    const options = createCalls[0];
    if (options?.mode !== 'command') throw new Error('missing command-mode creation');
    return options.command;
  };
  const actionMenuItem = (name: string) => [...host.querySelectorAll('button')].find((button) => (
    !button.hasAttribute('aria-label') && button.textContent?.startsWith(name)
  )) ?? null;
  const answer = async (choice: 'trust' | 'skip') => {
    await act(async () => { settleSharedTrustConfirmation(choice); });
  };
  const sharedAction = (patch: Partial<OpenChamberProjectAction> = {}) => {
    sharedHash = 'hash-A';
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo A', source: 'shared', ...patch }];
  };
  const refreshActions = async () => {
    await act(async () => { window.dispatchEvent(new Event(PROJECT_ACTIONS_UPDATED_EVENT)); });
  };

  for (const compact of [false, true]) {
    test(`shared dropdown Skip then primary asks again, compact=${compact}`, async () => {
      mockedDeviceInfo.isMobile = false;
      sharedAction();
      await renderButton({ compact });
      await click(actionMenuItem('Build'));
      expect(getSharedTrustConfirmationSnapshot()?.actions).toEqual([{ id: 'build', name: 'Build', command: 'echo A' }]);
      expect(createCalls).toHaveLength(0);
      expect(useTerminalStore.getState().getDirectoryState('/repo')?.tabs.length ?? 0).toBe(0);
      await answer('skip');
      expect(trustPatches).toEqual([]);
      await click(primary());
      expect(getSharedTrustConfirmationSnapshot()?.actions[0]?.command).toBe('echo A');
      expect(createCalls).toHaveLength(0);
      await answer('trust');
      expect(trustPatches).toEqual([{ sharedTrustHash: 'hash-A' }]);
      expect(createCalls).toHaveLength(1);
      expect(createdCommand()).toBe('echo A');
      expect(createCalls[0]?.cwd).toBe('/repo');
      // Command changes and trust withdrawal must not gate either Stop entrance.
      sharedHash = 'hash-B';
      mockedActionsState.actions[0].command = 'echo B';
      await refreshActions();
      await click(primary());
      expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      expect(sendCalls).toEqual([`${firstSessionId()}:\x03`]);
      expect(createCalls).toHaveLength(1);
      await click(primary());
      expect(getSharedTrustConfirmationSnapshot()?.actions[0]?.command).toBe('echo B');
      await answer('trust');
      expect(createCalls).toHaveLength(2);
      sharedHash = 'hash-C';
      await click(actionMenuItem('Build'));
      expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      expect(sendCalls).toEqual([`${firstSessionId()}:\x03`, `${secondSessionId()}:\x03`]);
    });

    test(`mobile first shared primary cannot bypass approval, compact=${compact}`, async () => {
      sharedAction();
      await renderButton({ compact });
      await click(primary());
      expect(getSharedTrustConfirmationSnapshot()?.actions[0]?.command).toBe('echo A');
      expect(createCalls).toHaveLength(0);
      await answer('skip');
      await click(primary());
      expect(getSharedTrustConfirmationSnapshot()).not.toBeNull();
      await answer('trust');
      expect(createCalls).toHaveLength(1);
    });

    test(`Auto-discovery retains shared action approval, compact=${compact}`, async () => {
      mockedDeviceInfo.isMobile = false;
      sharedAction({ name: 'Dev', runIn: 'parent' });
      useRealDetection = true;
      detectedDevServer.command = 'echo A';
      detectedDevServer.actionId = 'build';
      await renderButton({ compact, directory: '/repo-worktree' });
      await click(primary());
      expect(getSharedTrustConfirmationSnapshot()?.project.path).toBe('/repo-worktree');
      expect(getSharedTrustConfirmationSnapshot()?.actions).toEqual([{ id: 'build', name: 'Dev', command: 'echo A' }]);
      await answer('skip');
      expect(createCalls).toHaveLength(0);
      await click(actionMenuItem('Auto-discover'));
      expect(getSharedTrustConfirmationSnapshot()).not.toBeNull();
      await answer('trust');
      expect(createCalls).toHaveLength(1);
      expect(createdCommand()).toBe('echo A');
      expect(createCalls[0]?.cwd).toBe('/repo-worktree');
      expect(createCalls[0]?.purpose?.type === 'project-action' && createCalls[0].purpose.actionId).toBe('__openchamber_auto_discover_preview__');
    });
  }

  for (const change of ['command', 'runIn'] as const) {
    test(`stale ${change} refuses before approving B; explicitly selected current B may run`, async () => {
      sharedAction({ runIn: 'parent' });
      await renderButton({ directory: '/repo-worktree' });
      mockedActionsState.actions = [{ ...mockedActionsState.actions[0], command: change === 'command' ? 'echo B' : 'echo A', runIn: change === 'runIn' ? undefined : 'parent' }];
      sharedHash = 'hash-B';
      await click(primary());
      expect(createCalls).toHaveLength(0);
      expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      expect(trustPatches).toEqual([]);
      await click(actionMenuItem('Build'));
      expect(getSharedTrustConfirmationSnapshot()?.actions[0]?.command).toBe(change === 'command' ? 'echo B' : 'echo A');
      await answer('trust');
      expect(createCalls).toHaveLength(1);
      expect(createdCommand()).toBe(change === 'command' ? 'echo B' : 'echo A');
      expect(createCalls[0]?.cwd).toBe(change === 'runIn' ? '/repo-worktree' : '/repo');
      expect(trustPatches).toEqual([{ sharedTrustHash: 'hash-B' }]);
    });

    test(`a ${change} change during the dialog cannot dispatch the captured A`, async () => {
      sharedAction({ runIn: 'parent' });
      await renderButton({ directory: '/repo-worktree' });
      await click(primary());
      mockedActionsState.actions = [{ ...mockedActionsState.actions[0], command: change === 'command' ? 'echo B' : 'echo A', runIn: change === 'runIn' ? undefined : 'parent' }];
      sharedHash = 'hash-B';
      await refreshActions();
      expect(getSharedTrustConfirmationSnapshot()?.actions[0]?.command).toBe('echo A');
      await answer('trust');
      expect(createCalls).toHaveLength(0);
      expect(trustPatches).toEqual([{ sharedTrustHash: 'hash-A' }]);
      await click(primary());
      expect(getSharedTrustConfirmationSnapshot()).not.toBeNull();
      await answer('trust');
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]?.cwd).toBe(change === 'runIn' ? '/repo-worktree' : '/repo');
    });
  }

  test('approval of a newer B dialog with the same ID never launches the button\'s pending A', async () => {
    sharedAction();
    await renderButton();
    await click(primary());
    mockedActionsState.actions = [{ ...mockedActionsState.actions[0], command: 'echo B' }];
    sharedHash = 'hash-B';
    const newerSetup = await getProjectSetup({ id: 'project-1', path: '/repo' });
    const newerApproval = ensureSharedSetupTrusted({ id: 'project-1', path: '/repo' }, newerSetup);
    expect(getSharedTrustConfirmationSnapshot()?.actions[0]?.command).toBe('echo B');
    await answer('trust');
    expect(await newerApproval).toBe(true);
    expect(createCalls).toHaveLength(0);
    expect(trustPatches).toEqual([{ sharedTrustHash: 'hash-B' }]);
    await refreshActions();
    await click(actionMenuItem('Build'));
    expect(createCalls).toHaveLength(1);
    expect(createdCommand()).toBe('echo B');
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
  });

  test('a failed post-dialog strict read cannot launch an approved retained action', async () => {
    sharedAction();
    await renderButton();
    await click(primary());
    configReadFails = true;
    await answer('trust');
    expect(createCalls).toHaveLength(0);
    expect(trustPatches).toEqual([{ sharedTrustHash: 'hash-A' }]);
  });

  test('matching executable label/icon changes during confirmation keep the captured launch valid', async () => {
    sharedAction();
    await renderButton();
    await click(primary());
    mockedActionsState.actions = [{ ...mockedActionsState.actions[0], name: 'Renamed', icon: 'rocket' }];
    await refreshActions();
    await answer('trust');
    expect(createCalls).toHaveLength(1);
    expect(createdCommand()).toBe('echo A');
  });

  test('shared Stop is prompt-free while stopping and remains retryable after termination failure', async () => {
    sharedAction();
    await renderButton();
    await click(primary());
    await answer('trust');
    sharedHash = 'withdrawn';
    const originalSend = terminal.sendInput;
    const originalForceKill = terminal.forceKill;
    terminal.sendInput = async (id, input) => { sendCalls.push(`${id}:${input}`); };
    terminal.forceKill = async ({ sessionId }) => {
      forceKillCalls.push(sessionId ?? '');
      throw new Error('termination failed');
    };
    try {
      await click(primary());
      await click(primary());
      await click(actionMenuItem('Build'));
      expect(sendCalls).toHaveLength(1);
      expect(createCalls).toHaveLength(1);
      expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1050)); });
      const tab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((entry) => entry.purpose.type === 'project-action');
      expect(tab?.lifecycle).toBe('running');
      terminal.sendInput = originalSend;
      await click(actionMenuItem('Build'));
      expect(sendCalls).toHaveLength(2);
      expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      expect(createCalls).toHaveLength(1);
    } finally {
      terminal.sendInput = originalSend;
      terminal.forceKill = originalForceKill;
    }
  });

  test('matching approved executable tuple survives a label and icon refresh', async () => {
    sharedAction();
    trustedHash = sharedHash;
    await renderButton();
    mockedActionsState.actions = [{ ...mockedActionsState.actions[0], name: 'Renamed', icon: 'rocket' }];
    await refreshActions();
    await click(primary());
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
    expect(createCalls).toHaveLength(1);
    expect(createdCommand()).toBe('echo A');
    const tab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(tab?.label).toBe('Renamed');
    expect(tab?.iconKey).toBe('rocket');
    expect(trustPatches).toEqual([]);
  });

  test('strict config failure and trust reset cannot reuse loaded approval', async () => {
    sharedAction();
    trustedHash = sharedHash;
    await renderButton();
    configReadFails = true;
    await click(primary());
    expect(createCalls).toHaveLength(0);
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
    configReadFails = false;
    trustedHash = null;
    await click(primary());
    expect(getSharedTrustConfirmationSnapshot()).not.toBeNull();
    await answer('skip');
    expect(createCalls).toHaveLength(0);
  });

  for (const retired of ['runtime', 'project', 'directory', 'unmount'] as const) {
    test(`retired ${retired} dialog refuses before trust persistence and terminal dispatch`, async () => {
      sharedAction();
      await renderButton();
      await click(primary());
      expect(getSharedTrustConfirmationSnapshot()).not.toBeNull();
      if (retired === 'runtime') {
        configureRuntimeUrlResolver({ apiBaseUrl: 'http://new-runtime' });
        configureRuntimeUrlResolver({ apiBaseUrl: '' }); // Returning to A cannot revive its scope.
      } else if (retired === 'project') {
        await renderButton({ projectPath: '/new-project' });
      } else if (retired === 'directory') {
        await renderButton({ directory: '/other-worktree' });
      } else {
        await act(async () => root.unmount());
      }
      await answer('trust');
      expect(trustPatches).toEqual([]);
      expect(createCalls).toHaveLength(0);
    });
  }

  test('personal Auto-discovery preserves its action ID without asking', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [{ id: 'dev', name: 'Dev', command: 'bun run dev', source: 'personal' }];
    useRealDetection = true;
    detectedDevServer.command = 'bun run dev';
    detectedDevServer.actionId = 'dev';
    await renderButton();
    await click(primary());
    expect(getSharedTrustConfirmationSnapshot()).toBeNull();
    expect(createCalls).toHaveLength(1);
    expect(trustPatches).toEqual([]);
  });

  test('ordinary package-script discovery still launches without shared approval', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [];
    useRealDetection = true;
    packageScripts = { dev: 'vite' };
    const originalFetch = globalThis.fetch;
    const reads: string[] = [];
    // Real detector filesystem reads use the existing HTTP boundary, not a module mock.
    globalThis.fetch = async (input) => {
      reads.push(String(input));
      return new Response(JSON.stringify({ packageManager: 'bun@1.4.2' }));
    };
    try {
      await renderButton();
      await click(primary());
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain('/api/fs/read?');
      expect(getSharedTrustConfirmationSnapshot()).toBeNull();
      expect(createCalls).toHaveLength(1);
      expect(createdCommand()).toBe('bun run --shell=bun dev');
      expect(trustPatches).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // smarty-dev#777 G13: with nothing running, the header lists terminal sessions once and stays quiet; the 5 s loop
  // runs only while an action here is running (a run another client started counts once listed).
  const recordFiveSecondTimers = () => {
    const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
    const pending = new Map<symbol, () => void>();
    // 5 s timers (the loop's next listing, the header's join) are recorded, never run by themselves.
    globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay !== 5_000) return originalSetTimeout(callback, delay, ...args);
      const id = Symbol('five-seconds'); pending.set(id, callback); return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: unknown) => {
      if (typeof id === 'symbol') pending.delete(id); else originalClearTimeout(id as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;
    const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => originalSetTimeout(resolve, 1)); }); };
    const elapse = async () => { const due = [...pending.values()]; pending.clear(); await act(async () => { for (const run of due) run(); }); await settle(); };
    return { pending, settle, elapse, restore: () => { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; } };
  };

  test('the header polls terminal sessions only while an action is running', async () => {
    const originalList = terminal.listSessions, timers = recordFiveSecondTimers();
    let lists = 0; let running = false;
    Object.assign(terminal, { listSessions: async () => { lists++; return running ? [{
      sessionId: 'peer-run', cwd: '/repo', status: 'running', createdAt: 1, mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'peer-execution' },
    }] : []; } });
    try {
      await renderButton(); await timers.settle();
      expect(lists).toBe(1);
      expect(timers.pending.size).toBe(0); // Nothing running: nothing more is scheduled.
      // Counterexample: a run another client started, once listed, keeps the header watching it.
      await act(async () => root.unmount()); root = createRoot(host); running = true;
      await renderButton(); await timers.settle();
      expect(lists).toBe(2);
      await timers.elapse(); // The header joins the loop one interval later...
      expect(lists).toBe(3);
      await timers.elapse(); // ...and it keeps listing while the run goes on.
      expect(lists).toBe(4);
    } finally { terminal.listSessions = originalList; timers.restore(); }
  });

  test('a rerun whose terminal is still being created is not cancelled by its previous run\'s exited record', async () => {
    const originalList = terminal.listSessions, originalCreate = terminal.createSession, timers = recordFiveSecondTimers();
    try {
      await renderButton(); await timers.settle();
      const primaryButton = host.querySelector('button');
      if (!primaryButton) throw new Error('expected primary button');
      await act(async () => { primaryButton.dispatchEvent(new Event('click', { bubbles: true })); await Promise.resolve(); }); // Run.
      const first = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find(tab => tab.purpose.type === 'project-action');
      const firstExecution = first?.purpose.type === 'project-action' ? first.purpose.executionId : null;
      await act(async () => { primaryButton.dispatchEvent(new Event('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); // Stop.
      await timers.settle();
      // The server still lists the previous run, exited; the rerun's terminal takes a while to be created.
      Object.assign(terminal, { listSessions: async () => [{ sessionId: firstSessionId(), cwd: '/repo', status: 'exited', createdAt: 1, mode: 'command',
        purpose: { type: 'project-action', actionId: 'build', executionId: firstExecution } }] });
      let created = () => {}; const creating = new Promise<void>(resolve => { created = resolve; });
      Object.assign(terminal, { createSession: async (options: CreateTerminalOptions) => { await creating; return originalCreate(options); } });
      await act(async () => { primaryButton.dispatchEvent(new Event('click', { bubbles: true })); await Promise.resolve(); }); // Rerun.
      await timers.settle();
      created(); await timers.settle();
      const rerun = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find(tab => tab.purpose.type === 'project-action');
      expect(rerun?.terminalSessionId).toBe(secondSessionId());
      expect(rerun?.lifecycle).toBe('running');
      expect(closeCalls).toEqual([]);
    } finally { terminal.listSessions = originalList; terminal.createSession = originalCreate; timers.restore(); }
  });

  test('adopting a saved URL action does not auto-open a different output URL', async () => {
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', autoOpenUrl: true, openUrl: 'http://localhost:4000' }];
    const originalList = terminal.listSessions;
    Object.assign(terminal, { listSessions: async () => [{
      sessionId: 'peer-run', cwd: '/repo', status: 'running', createdAt: 1, mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'peer-execution' },
    }] });
    try {
      await renderButton();
      await act(async () => { emitToSession('peer-run', { type: 'snapshot', sequence: 1, status: 'running', data: 'Local: http://localhost:5173/\n' }); });
      expect(openExternalCalls).toEqual([]);
    } finally { terminal.listSessions = originalList; }
  });

  test('a second run keeps its tab and displays fresh output under a new terminal ID', async () => {
    const originalCreate = terminal.createSession;
    Object.assign(terminal, { createSession: async (options: CreateTerminalOptions) => {
      createCalls.push(options);
      return { sessionId: options.sessionId, cols: 80, rows: 24, status: 'running', mode: 'command', purpose: options.purpose };
    } });
    try {
      await renderButton();
      const button = host.querySelector('button');
      if (!button) throw new Error('missing action button');
      await act(async () => { button.click(); });
      const tab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
      if (!tab?.terminalSessionId) throw new Error('missing action terminal');
      const originalSessionId = tab.terminalSessionId;
      await act(async () => {
        emitToSession(originalSessionId, { type: 'snapshot', status: 'running', sequence: 5, data: 'old output' });
        emitToSession(originalSessionId, { type: 'exit', sequence: 6 });
      });
      await act(async () => { button.click(); });
      expect(secondSessionId()).not.toBe(firstSessionId());
      await act(async () => {
        emitToSession(secondSessionId(), { type: 'snapshot', status: 'running', sequence: 1, data: 'new output' });
      });
      const buffer = useTerminalStore.getState().getBuffer('/repo', tab.id);
      expect(buffer.chunks.map(chunk => chunk.data).join('')).toBe('new output');
    } finally { terminal.createSession = originalCreate; }
  });

  test('a stale rerun adopts the server run without closing it', async () => {
    await renderButton();
    const button = host.querySelector('button');
    if (!button) throw new Error('missing action button');
    await act(async () => { button.click(); });
    await act(async () => { emitToSession(firstSessionId(), { type: 'exit', sequence: 2 }); });
    const originalList = terminal.listSessions;
    const serverSession = {
      sessionId: firstSessionId(), cwd: '/repo', status: 'running', createdAt: 1,
      mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'other-client-new-run' },
    };
    Object.assign(terminal, { listSessions: async () => [serverSession] });
    try {
      await act(async () => { button.click(); });
      expect(closeCalls).toEqual([]);
      const tab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
      expect(tab?.purpose).toEqual(serverSession.purpose);
    } finally {
      terminal.listSessions = originalList;
    }
  });

  test('parent action manual URL opens in the current worktree panel', async () => {
    effectiveDirectory = '/repo-worktree';
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', runIn: 'parent', autoOpenUrl: true, openUrl: 'http://localhost:4000' }];
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });
    const button = host.querySelector('button');
    if (!button) throw new Error('missing action button');
    await act(async () => { button.click(); });
    expect(openContextPreviewCalls).toEqual([{ directory: '/repo-worktree', url: 'http://localhost:4000/' }]);
  });

  test('replaced executions cannot be cleared by their still-open old stream', async () => {
    await renderButton();
    const button = host.querySelector('button');
    if (!button) throw new Error('missing action button');
    await act(async () => { button.click(); });
    await act(async () => {
      useTerminalStore.getState().reconcileServerSessions('/repo', [{
        sessionId: 'other-session', cwd: '/repo', status: 'running', createdAt: 2,
        mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'new-execution' },
      }]);
    });
    await act(async () => { emitToSession(firstSessionId(), { type: 'exit', sequence: 10 }); });
    const tab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(tab?.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: 'new-execution' });
    expect(tab?.lifecycle).toBe('running');
  });

  test('runs, stops, and reruns on the same action tab while cleaning old subscriptions once', async () => {
    await renderButton();

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const firstTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(firstTab?.terminalSessionId).toBe(firstSessionId());
    expect(firstTab?.purpose.type).toBe('project-action');
    const firstExecution = firstTab?.purpose.type === 'project-action' ? firstTab.purpose.executionId : null;
    expect(firstExecution).not.toBeNull();

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const stoppedTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(stoppedTab?.lifecycle).toBe('exited');
    expect(stoppedTab?.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const rerunTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(rerunTab?.id).toBe(firstTab?.id);
    expect(rerunTab?.terminalSessionId).toBe(secondSessionId());
    expect(rerunTab?.lifecycle).toBe('running');
    const secondExecution = rerunTab?.purpose.type === 'project-action' ? rerunTab.purpose.executionId : null;
    expect(secondExecution).not.toBeNull();
    expect(secondExecution).not.toBe(firstExecution);

    expect(createCalls).toHaveLength(2);
    expect(sendCalls).toEqual([`${firstSessionId()}:\x03`]);
    expect(forceKillCalls).toEqual([]);
    expect(closeCalls).toEqual([]);
    expect(subscriptions.map((entry) => entry.closed)).toEqual([1, 1, 0]);
  });

  test('default action runs in the current worktree and stores its tab there', async () => {
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.cwd).toBe('/repo-worktree');
    expect(useTerminalStore.getState().getDirectoryState('/repo-worktree')?.tabs.some((tab) => tab.purpose.type === 'project-action' && tab.purpose.actionId === 'build')).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState('/repo')?.tabs.some((tab) => tab.purpose.type === 'project-action') ?? false).toBe(false);
    expect(openContextPanelTabCalls).toEqual([{ directory: '/repo-worktree', mode: 'terminal', targetDirectory: null }]);
  });

  test('parent action runs in the parent checkout, stores its tab there, and reveals it from the live worktree host', async () => {
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build', runIn: 'parent' }];
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.cwd).toBe('/repo');
    expect(useTerminalStore.getState().getDirectoryState('/repo')?.tabs.some((tab) => tab.purpose.type === 'project-action' && tab.purpose.actionId === 'build')).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState('/repo-worktree')?.tabs.some((tab) => tab.purpose.type === 'project-action') ?? false).toBe(false);
    expect(openContextPanelTabCalls).toEqual([{ directory: '/repo-worktree', mode: 'terminal', targetDirectory: '/repo' }]);
  });

  test('project action reveal uses the live effective host instead of the sticky action context directory', async () => {
    effectiveDirectory = '/live-host';
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.cwd).toBe('/repo-worktree');
    expect(openContextPanelTabCalls).toEqual([{ directory: '/live-host', mode: 'terminal', targetDirectory: '/repo-worktree' }]);
  });

  test('auto-discover without a preview hint settles on an announced localhost URL in context preview only', async () => {
    mockedDeviceInfo.isMobile = false;
    detectedDevServer.command = 'bun run dev';
    await renderButton();

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const autoDiscoverTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => (
      tab.purpose.type === 'project-action' && tab.purpose.actionId === '__openchamber_auto_discover_preview__'
    ));
    expect(autoDiscoverTab?.terminalSessionId).toBe(firstSessionId());

    await act(async () => {
      emitToSession(firstSessionId(), {
        type: 'data',
        data: 'Ready at http://127.0.0.1:4321\n',
        sequence: 1,
        replayData: undefined,
      });
    });
    await runWindowTimeouts(3_000);

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:4321' }]);
    expect(openExternalCalls).toEqual([]);
    await runWindowTimeouts(15_000);
    expect(openContextPanelTabCalls).toEqual([]);
  });

  test('auto-discover opens its terminal when no preview URL appears before the fallback timeout', async () => {
    mockedDeviceInfo.isMobile = false;
    detectedDevServer.command = 'bun run dev';
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo' });

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openContextPanelTabCalls).toEqual([]);
    effectiveDirectory = '/switched-after-launch';
    await runWindowTimeouts(15_000);
    expect(openContextPanelTabCalls).toEqual([{ directory: '/repo-worktree', mode: 'terminal', targetDirectory: '/repo' }]);
  });

  test('unmount closes active subscriptions and cancels pending preview timeouts', async () => {
    mockedDeviceInfo.isMobile = false;
    detectedDevServer.command = 'bun run dev';
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo' });

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.every((entry) => entry.closed === 0)).toBe(true);

    await act(async () => {
      root.unmount();
    });

    expect(subscriptions.every((entry) => entry.closed === 1)).toBe(true);

    effectiveDirectory = '/switched-after-unmount';
    await runWindowTimeouts(15_000);
    expect(openContextPanelTabCalls).toEqual([]);
  });

  test('stops watching running subscriptions when their execution directory leaves the watched set', async () => {
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build', runIn: 'parent' }];
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.every((entry) => entry.closed === 0)).toBe(true);

    await renderButton({ projectPath: '/other-repo', directory: '/other-repo' });

    expect(subscriptions.every((entry) => entry.closed === 1)).toBe(true);
  });

  test('manual action URL does not open a second output-derived URL', async () => {
    mockedActionsState.actions = [{
      id: 'build',
      name: 'Build',
      command: 'echo hello',
      icon: 'build',
      autoOpenUrl: true,
      openUrl: '127.0.0.1:3000',
    }];
    await renderButton();

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:3000/' }]);
    expect(openExternalCalls).toEqual([]);

    await act(async () => {
      emitToSession(firstSessionId(), {
        type: 'data',
        data: 'Server listening at http://127.0.0.1:4000\n',
        sequence: 1,
        replayData: undefined,
      });
      await Promise.resolve();
    });

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:3000/' }]);
    expect(openExternalCalls).toEqual([]);
  });
});
