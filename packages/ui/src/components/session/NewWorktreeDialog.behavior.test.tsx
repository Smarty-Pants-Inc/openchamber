import React, { act } from 'react';
import { createServer } from 'node:http';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { invalidateResolvedProjectRootCache } from '@/lib/worktrees/worktreeStatus';
import type { ProjectSetup } from '@/lib/openchamberConfig';
import { Window } from 'happy-dom';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

type GitHubSelection = {
  type: 'issue';
  item: { number: number; title: string };
};

const project = { id: 'project-a', path: '/workspace/project-a' };
let selectGitHubItem: ((selection: GitHubSelection) => void) | null = null;

const projectStoreState = { getActiveProject: () => project };
const githubAuthState = { status: { connected: true }, hasChecked: true };
const linearAuthState = { status: null, hasChecked: true };
const uiState = { isMobile: false };
const gitState = { fetchBranches: async () => undefined };
let worktreeCreations = 0;

const selectProjectState = <T,>(selector: (state: typeof projectStoreState) => T): T => selector(projectStoreState);
const selectGitHubAuthState = <T,>(selector: (state: typeof githubAuthState) => T): T => selector(githubAuthState);
const selectLinearAuthState = <T,>(selector: (state: typeof linearAuthState) => T): T => selector(linearAuthState);
const selectUIState = <T,>(selector: (state: typeof uiState) => T): T => selector(uiState);
const selectGitState = <T,>(selector: (state: typeof gitState) => T): T => selector(gitState);

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

const actualDialog = await import('@/components/ui/dialog');
const actualDropdownMenu = await import('@/components/ui/dropdown-menu');
const actualCommand = await import('@/components/ui/command');
const actualSessionUIStore = await import('@/sync/session-ui-store');
const actualSessionActions = await import('@/sync/session-actions');
const actualWorktreeManager = await import('@/lib/worktrees/worktreeManager');
const actualBranchNameGenerator = await import('@/lib/git/branchNameGenerator');

mock.module('@/components/ui/dialog', () => ({
  ...actualDialog,
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <>{children}</> : null,
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogTrigger: passthrough,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

mock.module('@/components/ui', () => ({
  toast: { error: () => undefined, success: () => undefined },
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  ...actualDropdownMenu,
  DropdownMenu: passthrough,
  DropdownMenuTrigger: passthrough,
  DropdownMenuContent: passthrough,
  DropdownMenuLabel: passthrough,
  DropdownMenuItem: passthrough,
  DropdownMenuRadioGroup: passthrough,
  DropdownMenuRadioItem: passthrough,
  DropdownMenuSeparator: passthrough,
  DropdownMenuSub: passthrough,
  DropdownMenuSubTrigger: passthrough,
  DropdownMenuSubContent: passthrough,
}));

mock.module('@/components/ui/command', () => ({
  ...actualCommand,
  Command: passthrough,
  CommandEmpty: passthrough,
  CommandGroup: passthrough,
  CommandInput: ({ onValueChange, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { onValueChange?: (value: string) => void }) => (
    <input {...props} onChange={(event) => onValueChange?.(event.target.value)} />
  ),
  CommandItem: passthrough,
  CommandList: passthrough,
  CommandShortcut: passthrough,
  CommandSeparator: () => null,
}));

mock.module('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: () => null }));
mock.module('@/components/ui/MobileOverlayPanel', () => ({
  MobileOverlayPanel: ({ children, footer, open }: React.PropsWithChildren<{ open: boolean; footer?: React.ReactNode }>) => open ? <div>{children}{footer}</div> : null,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/dropdown-trigger', () => ({ dropdownTriggerVariants: () => '' }));
mock.module('@/lib/utils', () => ({ cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ') }));

const actualProjectsStore = await import('@/stores/useProjectsStore');
const actualGitHubAuthStore = await import('@/stores/useGitHubAuthStore');
const actualLinearAuthStore = await import('@/stores/useLinearAuthStore');
const actualUIStore = await import('@/stores/useUIStore');
const actualGitStore = await import('@/stores/useGitStore');

mock.module('@/stores/useProjectsStore', () => ({
  ...actualProjectsStore,
  useProjectsStore: selectProjectState,
  visibleProjects: () => [project],
}));
mock.module('@/stores/useGitHubAuthStore', () => ({
  ...actualGitHubAuthStore,
  useGitHubAuthStore: selectGitHubAuthState,
}));
mock.module('@/stores/useLinearAuthStore', () => ({
  ...actualLinearAuthStore,
  useLinearAuthStore: selectLinearAuthState,
}));
mock.module('@/stores/useUIStore', () => ({
  ...actualUIStore,
  useUIStore: selectUIState,
}));
mock.module('@/sync/session-ui-store', () => ({
  ...actualSessionUIStore,
  materializeOpenDraftSession: async () => null,
  useSessionUIStore: actualSessionUIStore.useSessionUIStore,
}));
mock.module('@/sync/session-actions', () => ({
  ...actualSessionActions,
  createSession: async () => null,
  updateSessionTitle: async () => undefined,
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ github: {}, git: null, linear: null }),
}));
mock.module('@/stores/useGitStore', () => ({
  ...actualGitStore,
  useGitBranches: () => ({ all: ['main'] }),
  useGitLoadingBranches: () => false,
  useGitStore: selectGitState,
}));
mock.module('@/lib/worktrees/worktreeManager', () => ({
  ...actualWorktreeManager,
  validateWorktreeCreate: async () => ({ ok: true, errors: [] }),
}));

mock.module('@/lib/git/branchNameGenerator', () => ({
  ...actualBranchNameGenerator,
  generateBranchSlug: () => 'draft-name',
}));

mock.module('./GitHubIntegrationDialog', () => ({
  GitHubIntegrationDialog: ({ onSelect }: { onSelect: (selection: GitHubSelection) => void }) => {
    selectGitHubItem = onSelect;
    return null;
  },
}));
mock.module('./LinearIssuePickerDialog', () => ({ LinearIssuePickerDialog: () => null }));

const { NewWorktreeDialog } = await import('./NewWorktreeDialog');
const { createQuickWorktree } = await import('@/lib/worktreeSessionCreator');
const { I18nProvider } = await import('@/lib/i18n');

const personalSetup: ProjectSetup = {
  trust: { hash: null, trusted: true },
  setupWorktree: ['echo personal-$ROOT_PROJECT_PATH'],
  setupWorktreeWait: false,
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  shared: {
    status: 'missing', path: '.openchamber/project.json', setupWorktree: [],
    setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null,
  },
  personal: {
    setupWorktree: ['echo personal-$ROOT_PROJECT_PATH'], setupWorktreeWait: null,
    setupWorktreeMode: 'append', projectActions: [], projectActionsPrimaryId: null,
    draftStarters: [], hiddenSharedActionIds: [], sharedTrust: null,
  },
};

let configRead: () => Promise<Response> = async () => Response.json(personalSetup);
let gitCheckRead: () => Promise<Response> = async () => Response.json({ isGitRepository: true });
const createRequests: Array<{ runtime: string; body: string }> = [];
const unexpectedRequests: string[] = [];
let serverA: Awaited<ReturnType<typeof serveRuntime>>;
let serverB: Awaited<ReturnType<typeof serveRuntime>>;

const serveRuntime = async (runtime: string) => {
  const server = createServer(async (request, reply) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    let response: Response;
    if (path === '/auth/url-token') response = Response.json({ error: 'No fixture authentication' }, { status: 401 });
    else if (/^\/api\/projects\/[^/]+\/config$/.test(path) && request.method === 'GET') response = await configRead();
    else if (path === '/api/git/check') response = await gitCheckRead();
    else if (path === '/api/git/primary-root') response = Response.json({ root: project.path });
    else if (path === '/api/git/status') response = Response.json({ current: 'main', tracking: null, ahead: 0, behind: 0, isClean: true });
    else if (path === '/api/git/branches') response = Response.json({ all: ['main'], current: 'main', branches: {} });
    else if (path === '/api/git/worktrees' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) body += chunk;
      worktreeCreations += 1;
      createRequests.push({ runtime, body });
      response = Response.json({ name: 'created', branch: 'created', path: `${project.path}/created`, bootstrapStatus: { status: 'ready' } });
    } else {
      unexpectedRequests.push(`${runtime} ${request.method} ${path}`);
      response = Response.json({ error: 'Unexpected fixture request' }, { status: 500 });
    }
    reply.writeHead(response.status, { 'Content-Type': 'application/json' });
    reply.end(await response.text());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = z.object({ port: z.number().int().positive() }).parse(server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
};

beforeEach(async () => {
  createRequests.length = 0;
  unexpectedRequests.length = 0;
  worktreeCreations = 0;
  configRead = async () => Response.json(personalSetup);
  gitCheckRead = async () => Response.json({ isGitRepository: true });
  invalidateResolvedProjectRootCache();
  serverA = await serveRuntime('A');
  serverB = await serveRuntime('B');
  switchRuntimeEndpoint({ apiBaseUrl: serverA.origin, runtimeKey: serverA.origin });
});

afterEach(async () => {
  await Promise.all([serverA.stop(), serverB.stop()]);
  actualSessionUIStore.useSessionUIStore.setState({ availableWorktrees: [], availableWorktreesByProject: new Map() });
});

const holdConfigRead = () => {
  let release = () => {};
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const response = new Promise<Response>((resolve) => { release = () => resolve(Response.json(personalSetup)); });
  configRead = () => { markStarted(); return response; };
  return { started, release };
};

const settleDialogCreation = async (container: HTMLElement) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    if (![...container.querySelectorAll('button')].some((button) => button.textContent === 'Creating...')) return;
  }
  throw new Error('Dialog creation did not settle within one second');
};

const settleSourceBranch = async (container: HTMLElement) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    if ([...container.querySelectorAll('button')].some((button) => button.textContent === 'main')) return;
  }
  throw new Error('Source branch did not settle within one second');
};

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'KeyboardEvent',
  'Event',
  'HTMLIFrameElement',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    KeyboardEvent: happyWindow.KeyboardEvent,
    Event: happyWindow.Event,
    HTMLIFrameElement: happyWindow.HTMLIFrameElement,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      happyWindow.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

describe('worktree receiver origin custody over real Git HTTP', () => {
  for (const receiver of ['quick', 'dialog'] as const) {
    for (const returnToA of [false, true]) {
      test(`${receiver}: pending personal config A to B${returnToA ? ' to A' : ''} makes zero create POSTs`, async () => {
        const dom = installDom();
        const root = createRoot(dom.container);
        const held = holdConfigRead();
        let quickResult: Promise<string> | null = null;
        try {
          if (receiver === 'quick') {
            quickResult = createQuickWorktree(project, { preferredName: 'origin-custody' }).then(() => 'created', () => 'retired');
          } else {
            await act(async () => root.render(<I18nProvider><NewWorktreeDialog open onOpenChange={() => undefined} /></I18nProvider>));
            const input = dom.container.querySelector<HTMLInputElement>('input[placeholder="feature/my-awesome-feature"]');
            if (!input) throw new Error('Missing branch input');
            await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
          }
          await act(async () => {
            await held.started;
            switchRuntimeEndpoint({ apiBaseUrl: serverB.origin, runtimeKey: serverB.origin });
            if (returnToA) switchRuntimeEndpoint({ apiBaseUrl: serverA.origin, runtimeKey: serverA.origin });
          });
          await act(async () => { held.release(); await quickResult; });
          if (receiver === 'dialog') await settleDialogCreation(dom.container);
          expect(createRequests).toEqual([]);
          expect(unexpectedRequests).toEqual([]);
          if (quickResult) expect(await quickResult).toBe('retired');
        } finally {
          held.release();
          await act(async () => root.unmount());
          dom.restore();
        }
      });
    }
    for (const returnToA of [false, true]) {
      test(`${receiver}: retirement during late Git preparation${returnToA ? ' and return to A' : ''} makes zero create POSTs`, async () => {
        const dom = installDom();
        const root = createRoot(dom.container);
        let release = () => {};
        let markStarted = () => {};
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const response = new Promise<Response>((resolve) => { release = () => resolve(Response.json({ isGitRepository: true })); });
        gitCheckRead = () => { markStarted(); return response; };
        let quickResult: Promise<string> | null = null;
        try {
          if (receiver === 'quick') {
            quickResult = createQuickWorktree(project, { preferredName: 'late-git-custody' }).then(() => 'created', () => 'retired');
          } else {
            await act(async () => root.render(<I18nProvider><NewWorktreeDialog open onOpenChange={() => undefined} /></I18nProvider>));
            const input = dom.container.querySelector<HTMLInputElement>('input[placeholder="feature/my-awesome-feature"]');
            if (!input) throw new Error('Missing branch input');
            await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
          }
          await act(async () => {
            await started;
            switchRuntimeEndpoint({ apiBaseUrl: serverB.origin, runtimeKey: serverB.origin });
            if (returnToA) switchRuntimeEndpoint({ apiBaseUrl: serverA.origin, runtimeKey: serverA.origin });
            release();
            await quickResult;
          });
          if (receiver === 'dialog') await settleDialogCreation(dom.container);
          expect(createRequests).toEqual([]);
          expect(unexpectedRequests).toEqual([]);
          if (quickResult) expect(await quickResult).toBe('retired');
        } finally {
          release();
          await act(async () => root.unmount());
          dom.restore();
        }
      });
    }
    for (const offline of [false, true]) {
      test(`${receiver}: current ${offline ? 'offline optional config' : 'personal setup'} creates once on A`, async () => {
        const dom = installDom();
        const root = createRoot(dom.container);
        if (offline) configRead = async () => Response.json({ error: 'Config offline' }, { status: 503 });
        try {
          if (receiver === 'quick') {
            await createQuickWorktree(project, { preferredName: 'personal-control' });
          } else {
            await act(async () => root.render(<I18nProvider><NewWorktreeDialog open onOpenChange={() => undefined} /></I18nProvider>));
            const input = dom.container.querySelector<HTMLInputElement>('input[placeholder="feature/my-awesome-feature"]');
            if (!input) throw new Error('Missing branch input');
            await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
            await settleDialogCreation(dom.container);
          }
          expect(createRequests).toHaveLength(1);
          expect(createRequests[0].runtime).toBe('A');
          expect(JSON.parse(createRequests[0].body).startCommand).toBe(offline ? undefined : `echo personal-${project.path}`);
          expect(unexpectedRequests).toEqual([]);
        } finally {
          await act(async () => root.unmount());
          dom.restore();
        }
      });
    }
  }
});

describe('NewWorktreeDialog behavior', () => {
  for (const isMobile of [false, true]) {
    test(`${isMobile ? 'mobile' : 'desktop'} Enter in branch search does not create a worktree`, async () => {
      const dom = installDom();
      const root = createRoot(dom.container);
      uiState.isMobile = isMobile;
      worktreeCreations = 0;
      try {
        await act(async () => root.render(<I18nProvider><NewWorktreeDialog open onOpenChange={() => undefined} /></I18nProvider>));
        if (isMobile) {
          await settleSourceBranch(dom.container);
          const sourcePicker = [...dom.container.querySelectorAll('button')].find((button) => button.textContent === 'main');
          if (!sourcePicker) throw new Error('Missing source branch picker');
          await act(async () => sourcePicker.click());
        }
        const search = dom.container.querySelector<HTMLInputElement>('input[placeholder="Search branches..."]');
        if (!search) throw new Error('Missing branch search input');
        await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(worktreeCreations).toBe(0);
      } finally {
        await act(async () => root.unmount());
        uiState.isMobile = false;
        selectGitHubItem = null;
        dom.restore();
      }
    });
    for (const placeholder of ['feature/my-awesome-feature', 'my-worktree-directory']) {
      test(`${isMobile ? 'mobile' : 'desktop'} Enter in ${placeholder} creates once without reaching global shortcuts`, async () => {
        const dom = installDom();
        const root = createRoot(dom.container);
        uiState.isMobile = isMobile;
        worktreeCreations = 0;
        let globalEnters = 0;
        const globalShortcut = (event: KeyboardEvent) => { if (event.key === 'Enter') globalEnters += 1; };
        window.addEventListener('keydown', globalShortcut);
        try {
          await act(async () => root.render(<I18nProvider><NewWorktreeDialog open onOpenChange={() => undefined} /></I18nProvider>));
          const input = dom.container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
          if (!input) throw new Error('Missing worktree form field');
          const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (!setValue) throw new Error('Missing input value setter');
          await act(async () => {
            setValue.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
          expect(worktreeCreations).toBe(0);
          expect(globalEnters).toBe(0);
          await act(async () => {
            setValue.call(input, 'edited-worktree');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
            await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options })); });
          }
          expect(worktreeCreations).toBe(0);
          globalEnters = 0;
          const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
          await act(async () => { input.dispatchEvent(enter); });
          expect(enter.defaultPrevented).toBe(true);
          await settleDialogCreation(dom.container);
          expect(worktreeCreations).toBe(1);
          expect(globalEnters).toBe(0);
          await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true })); });
          expect(worktreeCreations).toBe(1);
        } finally {
          window.removeEventListener('keydown', globalShortcut);
          await act(async () => root.unmount());
          uiState.isMobile = false;
          selectGitHubItem = null;
          dom.restore();
        }
      });
    }
  }
  test('preserves selected issue values when available worktree names change', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    actualSessionUIStore.useSessionUIStore.setState({ availableWorktreesByProject: new Map() });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <NewWorktreeDialog open onOpenChange={() => undefined} />
        </I18nProvider>,
      ));
      if (!selectGitHubItem) throw new Error('Expected GitHub selection handler');

      await act(async () => selectGitHubItem?.({
        type: 'issue',
        item: { number: 42, title: 'Keep the selected issue' },
      }));

      const branchInput = dom.container.querySelector<HTMLInputElement>('input[placeholder="feature/my-awesome-feature"]');
      const worktreeInput = dom.container.querySelector<HTMLInputElement>('input[placeholder="my-worktree-directory"]');
      expect(branchInput?.value).toBe('issue-42-draft-name');
      expect(worktreeInput?.value).toBe('issue-42-draft-name');
      expect(dom.container.textContent).toContain('Keep the selected issue');

      // SAFETY: Test minimal worktree metadata stub for availableWorktreesByProject
      const worktreeStub = { name: 'newly-created-worktree' } as import('@/types/worktree').WorktreeMetadata;
      await act(async () => actualSessionUIStore.useSessionUIStore.setState({
        availableWorktreesByProject: new Map([
          [project.path, [worktreeStub]],
        ]),
      }));

      expect(branchInput?.value).toBe('issue-42-draft-name');
      expect(worktreeInput?.value).toBe('issue-42-draft-name');
      expect(dom.container.textContent).toContain('Keep the selected issue');
    } finally {
      await act(async () => root.unmount());
      actualSessionUIStore.useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
      selectGitHubItem = null;
      dom.restore();
    }
  });
});
