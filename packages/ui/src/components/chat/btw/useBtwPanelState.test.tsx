import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';
import type { BtwPanelState } from './useBtwPanelState';

type SessionWithDirectory = Session & { directory: string };

type GlobalSessionsState = {
  entityById: ReadonlyMap<string, SessionWithDirectory>;
};

type BtwStoreState = {
  byParent: Record<string, {
    collapsed?: boolean;
    creating?: boolean;
    destroying?: boolean;
  }>;
};

type SessionRequest = {
  directory: string | undefined;
  sessionId: string | null | undefined;
};

let globalSessions: GlobalSessionsState = { entityById: new Map() };
let btwStore: BtwStoreState = { byParent: {} };
let sessions = new Map<string, SessionWithDirectory>();
const sessionRequests: SessionRequest[] = [];

const sessionKey = (sessionId: string | null | undefined, directory: string | undefined): string => (
  `${directory ?? ''}\u0000${sessionId ?? ''}`
);

mock.module('@/sync/sync-context', () => ({
  useSession: (sessionId: string | null | undefined, directory?: string) => {
    sessionRequests.push({ directory, sessionId });
    return sessions.get(sessionKey(sessionId, directory));
  },
}));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  resolveGlobalSessionDirectory: (session: SessionWithDirectory) => session.directory,
  useGlobalSessionsStore: <T,>(selector: (state: GlobalSessionsState) => T): T => selector(globalSessions),
}));
mock.module('@/stores/useBtwStore', () => ({
  useBtwStore: <T,>(selector: (state: BtwStoreState) => T): T => selector(btwStore),
}));

// The hook must load after its dependency mocks are installed.
const { useBtwPanelState } = await import('./useBtwPanelState');

type BtwSessionFixture = {
  id: string;
  directory: string;
  title: string;
  time: { created: number; updated: number };
  metadata: SessionMetadataRecord;
};

const makeSession = (
  id: string,
  directory: string,
  metadata: SessionMetadataRecord = {},
): SessionWithDirectory => {
  const fixture: BtwSessionFixture = {
    id,
    directory,
    title: id,
    time: { created: 1, updated: 1 },
    metadata,
  };
  // SAFETY: the hook only reads these stable Session fields from this fixture.
  return fixture as SessionWithDirectory;
}

const renderPanelState = (): BtwPanelState => {
  let panelState: BtwPanelState | null = null;
  const Probe = () => {
    panelState = useBtwPanelState('parent', '/parent');
    return null;
  };

  renderToStaticMarkup(React.createElement(Probe));
  if (!panelState) throw new Error('BTW panel state was not rendered');
  return panelState;
};

beforeEach(() => {
  globalSessions = { entityById: new Map() };
  btwStore = { byParent: {} };
  sessions = new Map();
  sessionRequests.length = 0;
});

describe('useBtwPanelState', () => {
  test('uses the linked fork canonical directory rather than the parent directory', () => {
    const parent = makeSession('parent', '/parent', {
      openchamber: { btwSessionID: 'fork' },
    });
    const indexedFork = makeSession('fork', '/worktrees/canonical', {
      openchamber: { kind: 'btw', originalSessionID: 'parent' },
    });
    const liveFork = makeSession('fork', '/worktrees/canonical', {
      openchamber: {
        kind: 'btw',
        originalSessionID: 'parent',
        btwBoundaryMessageID: 'boundary',
      },
    });
    sessions.set(sessionKey('parent', '/parent'), parent);
    sessions.set(sessionKey('fork', '/worktrees/canonical'), liveFork);
    globalSessions = { entityById: new Map([['fork', indexedFork]]) };

    const panel = renderPanelState();

    expect(panel.btwSessionId).toBe('fork');
    expect(panel.btwSession).toBe(liveFork);
    expect(panel.btwDirectory).toBe('/worktrees/canonical');
    expect(panel.boundaryMessageID).toBe('boundary');
    expect(sessionRequests).toEqual([
      { directory: '/parent', sessionId: 'parent' },
      { directory: '/worktrees/canonical', sessionId: 'fork' },
    ]);
  });
});
