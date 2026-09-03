import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { SidebarHeader } from './SidebarHeader';

// renderToStaticMarkup cannot observe this store: zustand's React hook serves
// getInitialState() to useSyncExternalStore during SSR, so client-set state is
// invisible. A happy-dom client render exercises the real hook path. Globals
// are installed per test and fully restored afterwards so nothing leaks into
// the rest of the suite.

type HeaderProps = React.ComponentProps<typeof SidebarHeader>;

const createProps = (): HeaderProps => ({
  hideDirectoryControls: false,
  showProjectDisplayControls: true,
  showRecentControls: true,
  handleOpenDirectoryDialog: () => undefined,
  onOpenScheduled: () => undefined,
  onOpenMultiRun: () => undefined,
  canOpenMultiRun: true,
  onOpenArchive: () => undefined,
  headerActionIconClass: 'h-4 w-4',
  headerActionButtonClass: 'inline-flex h-6 w-6 items-center justify-center',
  isSessionSearchOpen: false,
  setIsSessionSearchOpen: () => undefined,
  sessionSearchInputRef: { current: null },
  sessionSearchQuery: '',
  setSessionSearchQuery: () => undefined,
  hasSessionSearchQuery: false,
  searchMatchCount: 0,
  collapseAllProjects: () => undefined,
  expandAllProjects: () => undefined,
});

const ADD_PROJECT_LABEL = 'Add project';

type HappyDomHarness = {
  renderHeader: (runtimeProjectMembershipActive: boolean) => Promise<string>;
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
    renderHeader: async (runtimeProjectMembershipActive) => {
      const original = useProjectsStore.getState();
      useProjectsStore.setState({ runtimeProjectMembershipActive });
      const element = happyDocument.createElement('div');
      happyDocument.body.appendChild(element);
      const mountedRoot = createRoot(element as unknown as HTMLElement);
      root = mountedRoot;
      try {
        await act(async () => {
          mountedRoot.render(<I18nProvider><SidebarHeader {...createProps()} /></I18nProvider>);
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

describe('SidebarHeader runtime membership gating', () => {
  test('renders the add-project control when settings own membership', async () => {
    harness = installHappyDom();
    expect(await harness.renderHeader(false)).toContain(ADD_PROJECT_LABEL);
  });

  test('omits the add-project control when the runtime owns membership', async () => {
    harness = installHappyDom();
    expect(await harness.renderHeader(true)).not.toContain(ADD_PROJECT_LABEL);
  });
});
