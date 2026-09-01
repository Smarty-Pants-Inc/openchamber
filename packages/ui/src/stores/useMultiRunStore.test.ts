import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { RetainedSessionError } from '@/lib/retainedSessionError';

type OpenChamberSessionMetadata = {
  openchamber?: {
    project_context_pins?: { notes: string[]; plans: string[] };
    agent_backend?: 'omp' | 'pi';
  };
};

type SessionCreateParams = { title?: string; metadata?: OpenChamberSessionMetadata; providerID?: string };

const upsertedSessions: Session[] = [];
const registeredDirectories: Array<{ sessionID: string; directory: string }> = [];
const ensureChildCalls: Array<{ directory: string; bootstrap?: boolean }> = [];
const worktreeMetadataCalls: Array<{ sessionId: string; path: string }> = [];
const worktreeCreateCalls: Array<{ project: { id?: string; path: string }; args: Record<string, unknown>; options: unknown }> = [];
const worktreeBootstrapWaitCalls: string[] = [];
const operationOrder: string[] = [];
const createSessionParams: SessionCreateParams[] = [];
let isGitRepository = false;
let waitForWorktreeSetup = false;
let createSessionFailure: Error | null = null;
const createSessionFailures: Error[] = [];
const createWorktreeWithDefaultsMock = mock((project: { id?: string; path: string }, args: Record<string, unknown>, options: unknown) => {
  worktreeCreateCalls.push({ project, args, options });
  return Promise.resolve({
    source: 'sdk',
    name: 'fix-thing',
    path: '/repo-worktrees/fix-thing',
    projectDirectory: '/repo',
    branch: 'fix-thing',
    label: 'fix-thing',
    worktreeRoot: '/repo-worktrees/fix-thing',
    worktreeStatus: 'pending',
    headState: 'branch',
    worktreeSource: 'created-for-session',
  });
});
const childState = {
  session: [] as Session[],
  sessionTotal: 0,
  limit: 5,
};
let currentDirectory = '/repo';

mock.module('@/sync/session-ui-store', () => ({
  routeMessage: mock(() => Promise.resolve()),
  useSessionUIStore: {
    getState: () => ({
      markSessionAsOpenChamberCreated: mock(() => undefined),
      setWorktreeMetadata: (sessionId: string, metadata: { path: string }) => {
        worktreeMetadataCalls.push({ sessionId, path: metadata.path });
      },
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    withDirectory: async (directory: string, fn: () => Promise<Session>) => {
      const previous = currentDirectory;
      currentDirectory = directory;
      try {
        return await fn();
      } finally {
        currentDirectory = previous;
      }
    },
    createSession: async (params?: SessionCreateParams): Promise<Session> => {
      createSessionParams.push(params ?? {});
      operationOrder.push(`createSession:${currentDirectory}`);
      if (params?.providerID === 'pi') {
        const failure = createSessionFailures.shift() ?? createSessionFailure;
        if (failure) throw failure;
      }
      return {
        id: 'ses_multirun',
        title: params?.title ?? '',
        directory: currentDirectory,
        time: { created: 1, updated: 1 },
      } as Session;
    },
  },
}));

mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: mock(() => Promise.resolve(isGitRepository)),
}));

mock.module('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: createWorktreeWithDefaultsMock,
  resolveRootTrackingRemote: mock(() => Promise.resolve(null)),
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeBootstrap: (directory: string) => {
    worktreeBootstrapWaitCalls.push(directory);
    operationOrder.push(`wait:${directory}`);
    return Promise.resolve();
  },
}));

mock.module('@/lib/worktrees/worktreeStatus', () => ({
  getRootBranch: mock(() => Promise.resolve('main')),
}));

mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeSetupWaitEnabled: mock(() => Promise.resolve(waitForWorktreeSetup)),
  saveWorktreeSetupCommands: mock(() => Promise.resolve()),
}));

mock.module('./useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({ currentDirectory: '/repo' }),
  },
}));

mock.module('./useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/repo' }],
    }),
  },
}));

mock.module('./useSnippetsStore', () => ({
  useSnippetsStore: {
    getState: () => ({
      expandText: (value: string) => Promise.resolve(value),
    }),
  },
}));

mock.module('./useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      upsertSession: (session: Session) => {
        upsertedSessions.push(session);
      },
    }),
  },
}));

mock.module('@/sync/sync-refs', () => ({
  getSyncSessionDirectory: () => null,
  registerSessionDirectory: (sessionID: string, directory: string) => {
    registeredDirectories.push({ sessionID, directory });
  },
  getSyncChildStores: () => ({
    ensureChild: (directory: string, options?: { bootstrap?: boolean }) => {
      ensureChildCalls.push({ directory, bootstrap: options?.bootstrap });
      return {
        setState: (updater: typeof childState | ((state: typeof childState) => Partial<typeof childState> | typeof childState)) => {
          const patch = typeof updater === 'function' ? updater(childState) : updater;
          if (patch !== childState) {
            Object.assign(childState, patch);
          }
        },
      };
    },
  }),
}));

const { useMultiRunStore } = await import('./useMultiRunStore');

describe('useMultiRunStore', () => {
  beforeEach(() => {
    upsertedSessions.length = 0;
    registeredDirectories.length = 0;
    ensureChildCalls.length = 0;
    worktreeMetadataCalls.length = 0;
    worktreeCreateCalls.length = 0;
    worktreeBootstrapWaitCalls.length = 0;
    operationOrder.length = 0;
    createSessionParams.length = 0;
    isGitRepository = false;
    waitForWorktreeSetup = false;
    createSessionFailure = null;
    createSessionFailures.length = 0;
    childState.session = [];
    childState.sessionTotal = 0;
    childState.limit = 5;
    currentDirectory = '/repo';
    useMultiRunStore.setState({ isLoading: false, error: null });
  });

  test('surfaces every retained Pi tuple when every requested run fails', async () => {
    createSessionFailures.push(
      new RetainedSessionError('First Pi session was retained', {
        sessionID: 'ses_retained',
        directory: '/repo-a',
        runtimeKey: 'runtime-a',
        cause: new Error('runtime changed'),
        compensationError: new Error('delete was not confirmed'),
      }),
      new RetainedSessionError('Second Pi session was retained', {
        sessionID: 'ses_retained',
        directory: '/repo-b',
        runtimeKey: 'runtime-b',
        cause: new Error('runtime changed'),
        compensationError: new Error('delete was not confirmed'),
      }),
    );

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: false,
      groups: [{
        prompt: 'Fix it',
        models: [
          { providerID: 'pi', modelID: 'default' },
          { providerID: 'pi', modelID: 'alternate' },
        ],
      }],
    });

    expect(result).toBeNull();
    expect(useMultiRunStore.getState().error).toBe(
      'Failed to create any sessions. Retained Pi sessions: runtimeKey=runtime-a, directory=/repo-a, sessionID=ses_retained; runtimeKey=runtime-b, directory=/repo-b, sessionID=ses_retained',
    );
  });

  test('surfaces retained Pi identities alongside successful partial runs', async () => {
    createSessionFailure = new RetainedSessionError('Pi session was retained', {
      sessionID: 'ses_retained_partial',
      directory: '/repo',
      runtimeKey: 'runtime-a',
      cause: new Error('runtime changed'),
      compensationError: new Error('delete was not confirmed'),
    });

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: false,
      groups: [{
        prompt: 'Fix it',
        models: [
          { providerID: 'pi', modelID: 'default' },
          { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
        ],
      }],
    });

    expect(result).toBeNull();
    expect(useMultiRunStore.getState().error).toBe(
      'Created 1 of 2 sessions. Retained Pi sessions: runtimeKey=runtime-a, directory=/repo, sessionID=ses_retained_partial',
    );
    expect(registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo' }]);
  });

  test('registers created sessions without waiting for a sidebar refresh', async () => {
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: false,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'pi', modelID: 'default' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(upsertedSessions.map((session) => session.id)).toEqual(['ses_multirun']);
    expect(registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo' }]);
    expect(ensureChildCalls).toEqual([{ directory: '/repo', bootstrap: false }]);
    expect(childState.session.map((session) => session.id)).toEqual(['ses_multirun']);
    expect(createSessionParams[0]?.providerID).toBe('pi');
  });

  test('uses fast background worktree creation for isolated runs', async () => {
    isGitRepository = true;

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(worktreeCreateCalls.length).toBe(1);
    expect(worktreeCreateCalls[0]?.project).toEqual({ id: 'project-1', path: '/repo' });
    expect(worktreeCreateCalls[0]?.args.returnAfterDirectoryCreated).toBe(true);
    expect(worktreeCreateCalls[0]?.options).toEqual({ resolvedRootTrackingRemote: null });
    expect(worktreeBootstrapWaitCalls).toEqual([]);
    expect(operationOrder).toEqual(['createSession:/repo-worktrees/fix-thing']);
    expect(registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo-worktrees/fix-thing' }]);
    expect(worktreeMetadataCalls).toEqual([{ sessionId: 'ses_multirun', path: '/repo-worktrees/fix-thing' }]);
  });

  test('waits for isolated worktree bootstrap when setup wait is enabled', async () => {
    isGitRepository = true;
    waitForWorktreeSetup = true;

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(worktreeBootstrapWaitCalls).toEqual(['/repo-worktrees/fix-thing']);
    expect(operationOrder).toEqual([
      'wait:/repo-worktrees/fix-thing',
      'createSession:/repo-worktrees/fix-thing',
    ]);
  });
});
