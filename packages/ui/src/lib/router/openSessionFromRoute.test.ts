import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as desktop from '@/lib/desktop';
import type { Session } from '@opencode-ai/sdk/v2';

import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

import { openSessionFromRoute } from './openSessionFromRoute';

const SESSION_ID = 'ses_linear_open';
const PROJECT_DIR = '/projects/linear-from-url';
const OTHER_DIR = '/projects/linear-from-url-other';

const buildSession = (id: string, directory: string): Session => ({
  id,
  title: id,
  directory,
  time: { created: 1, updated: 2 },
} as Session);

describe('openSessionFromRoute', () => {
  beforeEach(() => {
    useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
    useSessionUIStore.getState().setCurrentSession(null);
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      hasLoaded: true,
      status: 'ready',
    });
  });

  test('selects the routed session once the global list knows its directory', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [buildSession(SESSION_ID, PROJECT_DIR)],
      archivedSessions: [],
      hasLoaded: true,
      status: 'ready',
    });

    await openSessionFromRoute(SESSION_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
  });

  test('VS Code needs no managed discovery to open its known session', async () => {
    const vscode = spyOn(desktop, 'isVSCodeRuntime');
    vscode.mockReturnValue(true);
    try {
      useProjectsStore.setState({ managedCatalogStatus: 'unknown' });
      useGlobalSessionsStore.setState({ activeSessions: [buildSession(SESSION_ID, PROJECT_DIR)] });
      await openSessionFromRoute(SESSION_ID);
      expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);
      expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
    } finally { vscode.mockRestore(); }
  });

  test('replaces a guessed directory once the global list knows the owner', async () => {
    const id = 'ses_linear_guessed';
    useSessionUIStore.getState().setCurrentSession(id);
    const guessed = useSessionUIStore.getState().currentSessionDirectory;

    useGlobalSessionsStore.setState({
      activeSessions: [buildSession(id, OTHER_DIR)],
      archivedSessions: [],
      hasLoaded: true,
      status: 'ready',
    });

    await openSessionFromRoute(id);

    expect(useSessionUIStore.getState().currentSessionId).toBe(id);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(OTHER_DIR);
    expect(guessed).not.toBe(OTHER_DIR);
  });
});
