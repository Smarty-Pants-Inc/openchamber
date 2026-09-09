import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { create } from 'zustand';

const useDirectoryStore = create<{ homeDirectory: string }>(() => ({ homeDirectory: '/initial-home' }));
const projectState = { projects: [], addProject: async () => null, addProjects: async () => [] };
const selectProjectState = <T,>(selector: (state: typeof projectState) => T): T => selector(projectState);
const uiState = { setSessionSwitcherOpen: () => {} };
const select = <T,>(selector: (state: typeof uiState) => T): T => selector(uiState);
const gitIdentityState = { profiles: [], globalIdentity: null, defaultGitIdentityId: null, loadProfiles: async () => {}, loadGlobalIdentity: async () => {}, loadDefaultGitIdentityId: async () => {} };
const selectGitIdentity = <T,>(selector: (state: typeof gitIdentityState) => T): T => selector(gitIdentityState);
const sessionUiState = { openNewSessionDraft: () => {} };
const selectSessionUi = <T,>(selector: (state: typeof sessionUiState) => T): T => selector(sessionUiState);
let homeResolvers: Array<(response: Response) => void> = [];
let browseEntries: Array<{ name: string; path: string; isDirectory: boolean }> = [];

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => <input ref={ref} {...props} />);
const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(({ children, ...props }, ref) => <button ref={ref} {...props}>{children}</button>);

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <>{children}</> : null,
  DialogContent: passthrough, DialogDescription: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough,
}));
mock.module('@/components/ui/input', () => ({ Input }));
mock.module('@/components/ui/button', () => ({ Button }));
mock.module('@/components/ui', () => ({ toast: { error: () => {}, success: () => {} } }));
mock.module('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: passthrough }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/views/git/GitHeader', () => ({ IdentityDropdown: () => null }));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: selectProjectState }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: select }));
mock.module('@/stores/useGitIdentitiesStore', () => ({ useGitIdentitiesStore: selectGitIdentity }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: selectSessionUi }));
mock.module('@/hooks/useFileSystemAccess', () => ({ useFileSystemAccess: () => ({ canRequestAccess: false }) }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: () => new Promise<Response>((resolve) => homeResolvers.push(resolve)) }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getFilesystemHome: async () => null, listLocalDirectory: async () => browseEntries } }));
mock.module('@/lib/api/files-errors', () => ({ isFilesystemError: () => false }));

const bootstrapWindow = new Window({ url: 'http://localhost' });
Object.assign(globalThis, {
  window: bootstrapWindow,
  document: bootstrapWindow.document,
  navigator: bootstrapWindow.navigator,
  Node: bootstrapWindow.Node,
  Element: bootstrapWindow.Element,
  HTMLElement: bootstrapWindow.HTMLElement,
  HTMLInputElement: bootstrapWindow.HTMLInputElement,
  HTMLIFrameElement: bootstrapWindow.HTMLIFrameElement,
});
const { createRoot } = await import('react-dom/client');
const { DirectoryExplorerDialog } = await import('./DirectoryExplorerDialog');
const { I18nProvider } = await import('@/lib/i18n');

const installDom = () => {
  const window = new Window({ url: 'http://localhost' });
  const names = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  const values = { window, document: window.document, navigator: window.navigator, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Event: window.Event, MouseEvent: window.MouseEvent, requestAnimationFrame: (callback: FrameRequestCallback) => { frame += 1; frames.set(frame, callback); return frame; }, cancelAnimationFrame: (id: number) => frames.delete(id), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, flushFrames: () => { const queued = [...frames.values()]; frames.clear(); queued.forEach((callback) => callback(0)); }, restore: () => previous.forEach(([name, descriptor]) => descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name)) };
};

const resolveHomes = (home = '/resolved-home') => homeResolvers.splice(0).forEach((resolve) => resolve(new Response(JSON.stringify({ home }))));
const edit = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('DirectoryExplorerDialog behavior', () => {
  test('preserves an edited selection through late home resolution and publication', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    homeResolvers = [];
    useDirectoryStore.setState({ homeDirectory: '/initial-home' });
    try {
      await act(async () => root.render(<I18nProvider><DirectoryExplorerDialog open onOpenChange={() => {}} /></I18nProvider>));
      await act(async () => dom.flushFrames());
      const input = dom.container.querySelector<HTMLInputElement>('input');
      if (!input) throw new Error('Expected directory path input');
      await act(async () => edit(input, '/absolute-alpha'));
      input.setSelectionRange(0, input.value.length);
      await act(async () => useDirectoryStore.setState({ homeDirectory: '/published-home' }));
      await act(async () => { resolveHomes(); await Promise.resolve(); });
      await act(async () => dom.flushFrames());

      expect(input.value).toBe('/absolute-alpha');
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, '/absolute-alpha'.length]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('does not collapse a selection before the queued opening focus', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    homeResolvers = [];
    try {
      await act(async () => root.render(<I18nProvider><DirectoryExplorerDialog open onOpenChange={() => {}} /></I18nProvider>));
      const input = dom.container.querySelector<HTMLInputElement>('input');
      if (!input) throw new Error('Expected directory path input');
      input.focus();
      input.setSelectionRange(0, input.value.length);
      await act(async () => dom.flushFrames());
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('focuses on open and keeps focus while browsing by click', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    homeResolvers = [];
    browseEntries = [{ name: 'child', path: '/initial-home/child', isDirectory: true }];
    useDirectoryStore.setState({ homeDirectory: '/initial-home' });
    try {
      await act(async () => root.render(<I18nProvider><DirectoryExplorerDialog open onOpenChange={() => {}} /></I18nProvider>));
      await act(async () => { resolveHomes(); await Promise.resolve(); dom.flushFrames(); });
      const input = dom.container.querySelector<HTMLInputElement>('input');
      const child = [...dom.container.querySelectorAll('button')].find((button) => button.textContent === 'child');
      if (!input || !child) throw new Error('Expected focused input and browse row');
      expect(document.activeElement).toBe(input);
      await act(async () => child.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(input.value).toBe('~/child/');
      expect(document.activeElement).toBe(input);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
