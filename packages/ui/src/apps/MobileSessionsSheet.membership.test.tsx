import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';

// Module mocks must be registered before MobileSessionsSheet captures its
// imports — hence the dynamic import below after mock.module.
mock.module('@/sync/sync-context', () => ({
  useAllLiveSessions: () => [],
  useGlobalSessionStatus: () => undefined,
}));
// Stable identity: the sheet's worktree effect depends on `git`, so a fresh
// object per render would loop.
const runtimeApisStub = { git: { checkIsGitRepository: async () => false } };
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => runtimeApisStub,
}));
mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: null }),
}));
mock.module('@/components/ui', () => ({
  toast: { success: () => undefined, error: () => undefined },
}));
mock.module('@/components/ui/ScrollShadow', () => ({
  ScrollShadow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  refreshGlobalSessions: async () => undefined,
  mergeLiveSessionWithGlobalSession: (live: unknown, fallback: unknown) => fallback ?? live,
  useGlobalSessionsStore: (selector: (state: { activeSessions: unknown[] }) => unknown) => (
    selector({ activeSessions: [] })
  ),
}));
mock.module('@/components/session/DirectoryExplorerDialog', () => ({
  DirectoryExplorerDialog: () => null,
}));
mock.module('@/components/session/NewWorktreeDialog', () => ({
  NewWorktreeDialog: () => null,
}));
mock.module('./MobileProjectEditSurface', () => ({
  MobileProjectEditSurface: () => null,
}));
mock.module('./MobileDeleteWorktreeDialog', () => ({
  MobileDeleteWorktreeDialog: () => null,
}));

const { MobileSessionsSheet } = await import('./MobileSessionsSheet');

const ADD_PROJECT_LABEL = 'Add project';
const EDIT_ORDER_LABEL = 'Reorder projects';
// getProjectLabel('/project-a') normalizes dashes to spaces.
const REMOVE_PROJECT_LABEL = 'Remove project a';

type HappyDomHarness = {
  renderSheet: (runtimeProjectMembershipActive: boolean) => Promise<string>;
  restore: () => Promise<void>;
};

const installHappyDom = (): HappyDomHarness => {
  const happyWindow = new Window({ url: 'http://localhost/' });
  const happyDocument = happyWindow.document;
  const domGlobals = {
    window: happyWindow,
    document: happyDocument,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    Element: happyWindow.Element,
    Node: happyWindow.Node,
    MutationObserver: happyWindow.MutationObserver,
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  } as const;
  const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(domGlobals)) {
    savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let root: Root | null = null;

  return {
    renderSheet: async (runtimeProjectMembershipActive) => {
      const original = useProjectsStore.getState();
      const membershipProjects = [
        { id: 'project-a', path: '/project-a' },
        { id: 'project-b', path: '/project-b' },
      ];
      useProjectsStore.setState({
        projects: membershipProjects,
        presentationProjects: membershipProjects,
        runtimeProjectMembershipActive,
        activeProjectId: 'project-a',
        manualProjectOrder: [],
      });
      const element = happyDocument.createElement('div');
      happyDocument.body.appendChild(element);
      const mountedRoot = createRoot(element as unknown as HTMLElement);
      root = mountedRoot;
      try {
        await act(async () => {
          mountedRoot.render(
            <I18nProvider>
              <MobileSessionsSheet open variant="sidebar" onOpenChange={() => undefined} />
            </I18nProvider>,
          );
        });
        return element.innerHTML;
      } finally {
        await act(async () => {
          mountedRoot.unmount();
        });
        root = null;
        element.remove();
        useProjectsStore.setState(original, true);
      }
    },
    restore: async () => {
      if (root) {
        root.unmount();
        root = null;
      }
      for (const [key, descriptor] of savedDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await happyWindow.happyDOM.close();
    },
  };
};

let harness: HappyDomHarness | null = null;

afterEach(async () => {
  await harness?.restore();
  harness = null;
});

describe('MobileSessionsSheet runtime membership gating', () => {
  test('renders add, remove, and edit-order controls when settings own membership', async () => {
    harness = installHappyDom();
    const html = await harness.renderSheet(false);
    expect(html).toContain(ADD_PROJECT_LABEL);
    expect(html).toContain(EDIT_ORDER_LABEL);
    expect(html).toContain(REMOVE_PROJECT_LABEL);
  });

  test('hides add, remove, and edit-order controls when the runtime owns membership', async () => {
    harness = installHappyDom();
    const html = await harness.renderSheet(true);
    expect(html).not.toContain(ADD_PROJECT_LABEL);
    expect(html).not.toContain(EDIT_ORDER_LABEL);
    expect(html).not.toContain(REMOVE_PROJECT_LABEL);
  });
});
