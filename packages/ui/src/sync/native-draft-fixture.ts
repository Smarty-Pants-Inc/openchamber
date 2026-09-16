import { spyOn } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import type { NativeCreatedSession } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { ChildStoreManager } from './child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import { setActionRefs, setOptimisticRefs } from './session-actions';
import { setSyncRefs } from './sync-refs';
import { useInputStore } from './input-store';
import { useSessionUIStore, type NewSessionDraftState } from './session-ui-store';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
export const directory = '/native-project-a';
export const acceptedView = `ov2_${'a'.repeat(64)}`;
export const session: NativeCreatedSession = { id: '01234567-1234-4234-9234-012345678901', slug: 'native', projectID: 'a', directory,
  title: 'Pi', version: '1', time: { created: 1, updated: 1 },
  nativeCreation: { model: { providerID: 'native-provider', modelID: 'native-model' }, inputReady: false } };
export const draft: NewSessionDraftState = { draftId: 400, open: true, target: 'project', selectedProjectId: 'a',
  directoryOverride: directory, parentID: null, initialPrompt: 'Keep @notes.md',
  syntheticParts: [{ text: 'draft-only context', synthetic: true }] };

export function nativeDraftFixture() {
  const initialUI = useSessionUIStore.getState(), initialInput = useInputStore.getState();
  const initialProjects = useProjectsStore.getState(), initialConfig = useConfigStore.getState();
  const initialDirectory = useDirectoryStore.getState(), initialGlobal = useGlobalSessionsStore.getState();
  const initialRuntime = getRuntimeKey();
  const runtimeA = `native-test-${crypto.randomUUID()}`;
  const requests: Request[] = [];
  const handlers = {
    health: async (): Promise<Response> => Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1, displayAttribution: 1 } }),
    create: async (request: Request): Promise<Response> => {
      if (request.method !== 'POST') throw new Error('Expected native creation POST');
      return Response.json(session);
    }
    settings: async (): Promise<Response> => Response.json({}),
    snippet: async (): Promise<Response> => Response.json({ text: 'expanded X' }),
    magic: async (): Promise<Response> => Response.json({ version: 1, overrides: {} }),
    knowledge: async (): Promise<Response> => new Response(null, { status: 404 }),
    history: async (): Promise<Response> => Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } }),
    prompt: async (request: Request): Promise<Response> => {
      if (request.method !== 'POST') throw new Error('Expected native prompt POST');
      return new Response(null, { status: 204 });
    }
  };
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init); requests.push(request.clone());
    const url = new URL(request.url);
    if (url.hostname !== 'synthetic.invalid') throw new Error('Unexpected network target');
    if (url.pathname.endsWith('/global/health')) return handlers.health();
    if (url.pathname.endsWith('/session') && request.method === 'POST') return handlers.create(request);
    if (url.pathname.endsWith('/message') && request.method === 'GET') return handlers.history();
    if (url.pathname.endsWith('/prompt_async')) return handlers.prompt(request);
    if (url.pathname.endsWith('/session-knowledge')) return handlers.knowledge();
    if (url.pathname.endsWith('/config/settings')) return handlers.settings();
    if (url.pathname.endsWith('/snippets/expand')) return handlers.snippet();
    if (url.pathname.endsWith('/magic-prompts')) return handlers.magic();
    // Incidental project knowledge/configuration is unavailable, not another test authority.
    return new Response(null, { status: 404 });
  });
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://synthetic.invalid' });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeA });
  opencodeClient.reconnectToRuntimeBaseUrl(); opencodeClient.setDirectory(directory);
  const sdk = opencodeClient.getSdkClient();
  const children = new ChildStoreManager();
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey: runtimeA });
  setImperativeSessionMessageLoader(loader);
  setSyncRefs(sdk, children, directory);
  setActionRefs(sdk, children, () => directory);
  setOptimisticRefs(
    input => loader.optimisticAdd({ ...input, directory: input.directory ?? directory }),
    input => loader.optimisticRemove({ ...input, directory: input.directory ?? directory }),
    input => loader.optimisticConfirm({ ...input, directory: input.directory ?? directory }),
  );
  useConfigStore.setState({ isConnected: true });
  useProjectsStore.setState({ projects: [{ id: 'a', path: directory }, { id: 'b', path: '/native-project-b' }], activeProjectId: 'a' });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...draft }, nativeDraftCreations: new Map() });
  useInputStore.setState({ pendingInputText: 'Keep @notes.md', pendingSyntheticParts: [{ text: 'input context', synthetic: true }],
    attachedFiles: [{ id: 'file-one', filename: 'notes.md', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,bm90ZXM=',
      source: 'local', file: new File(['notes'], 'notes.md', { type: 'text/plain' }), size: 5 }] });
  return {
    requests, handlers, loader, children, runtimeA,
    creates: () => requests.filter(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/session')),
    prompts: () => requests.filter(r => new URL(r.url).pathname.endsWith('/prompt_async')),
    target: (projectId: string, path: string) => useSessionUIStore.getState().setNewSessionDraftTarget({ projectId, directoryOverride: path }),
    switchRuntime: (runtimeKey: string) => {
      useSessionUIStore.getState().prepareForRuntimeSwitch();
      switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey });
      opencodeClient.reconnectToRuntimeBaseUrl();
      const nextSdk = opencodeClient.getSdkClient();
      loader.configure({ sdk: nextSdk, runtimeKey });
      setSyncRefs(nextSdk, children, directory);
      setActionRefs(nextSdk, children, () => directory);
      useSessionUIStore.getState().restoreForRuntimeSwitch();
    },
    dispose: () => {
      loader.dispose(); children.disposeAll(); setImperativeSessionMessageLoader(null);
      useSessionUIStore.setState(initialUI, true); useInputStore.setState(initialInput, true);
      useProjectsStore.setState(initialProjects, true); useConfigStore.setState(initialConfig, true);
      useDirectoryStore.setState(initialDirectory, true); useGlobalSessionsStore.setState(initialGlobal, true);
      switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: initialRuntime });
      configureRuntimeUrlResolver({}); opencodeClient.reconnectToRuntimeBaseUrl(); fetchMock.mockRestore();
    },
  };
}
