import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2';
import type { SessionMetadataRecord } from './sessionReviewMetadata';
import { RetainedSessionError } from './retainedSessionError';

type SendMessageOptions = {
  target: {
    directory: string;
    runtimeKey: string;
    sessionId: string;
  };
};

type SendMessageArgs = [
  question: string,
  providerID: string,
  modelID: string,
  agent: string | undefined,
  attachments: [],
  messageID: undefined,
  noAutoScroll: undefined,
  variant: string | undefined,
  mode: 'normal',
  options: SendMessageOptions,
];

type SessionMessageRecord = { info: Message; parts: Part[] };

let forkSessionWithAuthorizationImpl: (
  sessionId: string,
  messageId: string | undefined,
  providerID: string | undefined,
  directory: string | null | undefined,
) => Promise<Session>;
let getSessionMessagesImpl: (id: string, limit?: number, directory?: string | null) => Promise<SessionMessageRecord[]>;
let getSessionImpl: (id: string, directory?: string | null) => Promise<Session>;
let sendMessageImpl: (...args: SendMessageArgs) => Promise<void>;
let deleteSessionImpl: (sessionId: string) => Promise<boolean>;
let updateSessionTitleImpl: (sessionId: string, title: string, directory?: string | null) => Promise<Session>;
let patchSessionMetadataImpl: (
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
) => Promise<Session>;
let assertOperationCurrentImpl: () => void;

const currentSessionSwitches: string[] = [];
const metadataPatches: Array<{ sessionId: string; result: SessionMetadataRecord }> = [];
const deleteSessionCalls: Array<{
  sessionId: string;
  options: { directory?: string | null; skipRelationshipCleanup?: boolean; expectedRuntimeKey?: string };
}> = [];
const boundDeleteCalls: Array<{ sessionId: string; directory: string | null | undefined }> = [];
const publishedSessions: Array<{ session: Session; directory: string | null | undefined }> = [];
const finalizedDeletionCalls: Array<{ sessionId: string; directory: string | null | undefined }> = [];
let releaseCalls = 0;

mock.module('@/sync/session-actions', () => ({
  waitForConnectionOrThrow: () => Promise.resolve(),
  bindSessionOperation: () => ({
    runtimeKey: 'runtime-a',
    get: (sessionId: string, directory?: string | null) => getSessionImpl(sessionId, directory),
    getMessages: (sessionId: string, limit?: number, directory?: string | null) => (
      getSessionMessagesImpl(sessionId, limit, directory)
    ),
    patchMetadata: (
      sessionId: string,
      directory: string | null | undefined,
      updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
    ) => patchSessionMetadataImpl(sessionId, directory, updater),
    fork: (
      sessionId: string,
      messageId?: string,
      providerID?: string,
      directory?: string | null,
    ) => forkSessionWithAuthorizationImpl(sessionId, messageId, providerID, directory),
    delete: (sessionId: string, directory?: string | null) => {
      boundDeleteCalls.push({ sessionId, directory });
      return deleteSessionImpl(sessionId);
    },
    updateTitle: (sessionId: string, title: string, directory?: string | null) => (
      updateSessionTitleImpl(sessionId, title, directory)
    ),
    assertCurrent: () => assertOperationCurrentImpl(),
    publish: (session: Session, directory?: string | null) => {
      assertOperationCurrentImpl();
      publishedSessions.push({ session, directory });
      return session;
    },
    finalizeDeletion: (sessionId: string, directory?: string | null) => {
      assertOperationCurrentImpl();
      finalizedDeletionCalls.push({ sessionId, directory });
    },
    release: () => { releaseCalls += 1; },
  }),
  deleteSession: (sessionId: string, options: { directory?: string | null; skipRelationshipCleanup?: boolean; expectedRuntimeKey?: string }) => {
    deleteSessionCalls.push({ sessionId, options });
    return deleteSessionImpl(sessionId);
  },
  patchSessionMetadata: (
    sessionId: string,
    directory: string | null | undefined,
    updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
  ) => patchSessionMetadataImpl(sessionId, directory, updater),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: SendMessageArgs) => sendMessageImpl(...args),
      setCurrentSession: (sessionId: string) => { currentSessionSwitches.push(sessionId); },
    }),
  },
}));

// These modules must load after their dependency mocks are installed.
const { adoptBtwNewestPageAuthority, btwSessionTitle, startBtwSession, destroyBtwSession, promoteBtwSession, filterBtwTailMessages, isBtwNewestPageResolved } =
  await import('@/lib/btw');
const { useBtwStore } = await import('@/stores/useBtwStore');

const makeSession = (id: string, directory = '/project', metadata?: SessionMetadataRecord): Session => {
  const session: Session = {
    id,
    slug: id,
    projectID: 'project',
    directory,
    title: 'btw: q',
    time: { created: Date.now(), updated: Date.now() },
    version: '1',
  };
  if (metadata) session.metadata = metadata;
  return session;
};

const record = (id: string): SessionMessageRecord => ({
  info: {
    id,
    sessionID: 'fork-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'pi', modelID: 'model' },
  },
  parts: [],
});

const startInput = {
  parentSessionId: 'parent-1',
  question: 'wtf is kafka',
  directory: '/project',
  providerID: 'pi',
  modelID: 'model',
  agent: 'build',
  variant: 'v',
};

const installBtwMetadata = (metadataBySession: Map<string, SessionMetadataRecord>): void => {
  getSessionImpl = (sessionId, directory) => Promise.resolve({
    ...makeSession(sessionId, directory ?? '/project'),
    metadata: metadataBySession.get(sessionId) ?? {},
  });
  patchSessionMetadataImpl = (sessionId, _directory, updater) => {
    const result = updater(metadataBySession.get(sessionId) ?? {});
    metadataBySession.set(sessionId, result);
    metadataPatches.push({ sessionId, result });
    return Promise.resolve({ ...makeSession(sessionId), metadata: result });
  };
};

beforeEach(() => {
  currentSessionSwitches.length = 0;
  metadataPatches.length = 0;
  deleteSessionCalls.length = 0;
  boundDeleteCalls.length = 0;
  publishedSessions.length = 0;
  finalizedDeletionCalls.length = 0;
  releaseCalls = 0;
  useBtwStore.setState({ byParent: {} });
  forkSessionWithAuthorizationImpl = () => Promise.reject(new Error('no fork authorization stub'));
  getSessionImpl = (id, directory) => Promise.resolve(makeSession(id, directory ?? '/project'));
  getSessionMessagesImpl = () => Promise.resolve([record('msg-boundary')]);
  sendMessageImpl = () => Promise.resolve();
  deleteSessionImpl = () => Promise.resolve(true);
  updateSessionTitleImpl = (sessionId, title, directory) => Promise.resolve({
    ...makeSession(sessionId, directory ?? '/project'),
    title,
  });
  patchSessionMetadataImpl = (sessionId, _directory, updater) => {
    const result = updater({});
    metadataPatches.push({ sessionId, result });
    return Promise.resolve({ ...makeSession(sessionId), metadata: result });
  };
  assertOperationCurrentImpl = () => undefined;
});

describe('btwSessionTitle', () => {
  test('prefixes the question', () => {
    expect(btwSessionTitle('wtf is kafka')).toBe('btw: wtf is kafka');
  });
});

describe('filterBtwTailMessages', () => {
  test('uses record order when fork-tail IDs sort below and inherited IDs sort above the boundary', () => {
    const records = [record('msg-z-inherited'), record('msg-m-boundary'), record('msg-a-fork-tail')];
    expect(filterBtwTailMessages(records, 'msg-m-boundary').map((r) => r.info.id)).toEqual(['msg-a-fork-tail']);
  });

  test('keeps a missing boundary hidden until the newest page resolves', () => {
    const records = [record('msg-1'), record('msg-2')];
    expect(filterBtwTailMessages(records, 'msg-missing')).toEqual([]);
    expect(filterBtwTailMessages(records, 'msg-missing', true)).toBe(records);
  });

  test('a null boundary keeps everything (fork of an empty parent)', () => {
    const records = [record('msg-1'), record('msg-2')];
    expect(filterBtwTailMessages(records, null)).toBe(records);
  });
});

describe('isBtwNewestPageResolved', () => {
  test('keeps newest-page authority through later same-target loading and errors', () => {
    expect(isBtwNewestPageResolved(4, 5)).toBe(true);
    expect(isBtwNewestPageResolved(4, 6)).toBe(true);
  });
});

describe('adoptBtwNewestPageAuthority', () => {
  test('adopts only a newer successful generation for the same target', () => {
    expect(adoptBtwNewestPageAuthority({ target: 'a', generation: 2 }, 'a', 3, 'ready'))
      .toEqual({ target: 'a', generation: 3 });
    expect(adoptBtwNewestPageAuthority({ target: 'a', generation: 3 }, 'a', 2, 'ready'))
      .toEqual({ target: 'a', generation: 3 });
    expect(adoptBtwNewestPageAuthority({ target: 'a', generation: 2 }, 'a', 3, 'error'))
      .toEqual({ target: 'a', generation: 2 });
  });
});

describe('startBtwSession', () => {
  test('stops after the server rejects a managed parent fork', async () => {
    let forkCalls = 0;
    forkSessionWithAuthorizationImpl = () => {
      forkCalls += 1;
      return Promise.reject(new Error('Managed Pi/OMP sessions cannot be forked'));
    };

    await expect(startBtwSession(startInput)).rejects.toThrow('cannot be forked');

    expect(forkCalls).toBe(1);
    expect(metadataPatches).toEqual([]);
    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('forks through server authorization, marks the fork, links the parent, and routes the question to the fork', async () => {
    forkSessionWithAuthorizationImpl = (sessionId, messageId, providerID, directory) => {
      expect(sessionId).toBe('parent-1');
      expect(messageId).toBe(undefined);
      expect(providerID).toBe('pi');
      expect(directory).toBe('/project');
      return Promise.resolve(makeSession('fork-1', directory ?? '/project'));
    };
    let sentText: string | null = null;
    let sentOptions: SendMessageOptions | null = null;
    sendMessageImpl = (...args) => {
      sentText = args[0];
      sentOptions = args[9];
      return Promise.resolve();
    };

    const session = await startBtwSession(startInput);

    expect(session.id).toBe('fork-1');
    expect(publishedSessions.map(({ session: published, directory }) => ({
      directory,
      sessionId: published.id,
    }))).toEqual([
      { directory: '/project', sessionId: 'fork-1' },
      { directory: '/project', sessionId: 'parent-1' },
    ]);
    expect(sentText).toBe('wtf is kafka');
    expect(sentOptions).toEqual({ target: { runtimeKey: 'runtime-a', sessionId: 'fork-1', directory: '/project' } });
    expect(metadataPatches).toEqual([
      { sessionId: 'fork-1', result: { openchamber: { kind: 'btw', originalSessionID: 'parent-1', agent_backend: 'pi' } } },
      { sessionId: 'fork-1', result: { openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-boundary', agent_backend: 'pi' } } },
      { sessionId: 'parent-1', result: { openchamber: { btwSessionID: 'fork-1' } } },
    ]);
    // Transient creating flag is cleared once the flow settles.
    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('an empty parent produces a marker without a boundary', async () => {
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    getSessionMessagesImpl = () => Promise.resolve([]);
    await startBtwSession(startInput);
    expect(metadataPatches.slice(0, 2).map((patch) => patch.result)).toEqual([
      { openchamber: { kind: 'btw', originalSessionID: 'parent-1', agent_backend: 'pi' } },
      { openchamber: { kind: 'btw', originalSessionID: 'parent-1', agent_backend: 'pi' } },
    ]);
  });

  test('a failed first send unlinks the parent and deletes the fork', async () => {
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    sendMessageImpl = () => Promise.reject(new Error('send failed'));
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    await expect(startBtwSession(startInput)).rejects.toThrow('send failed');

    expect(deleted).toEqual(['fork-1']);
    // initial marker, boundary marker, link, then unlink rollback
    expect(metadataPatches.map((p) => p.sessionId)).toEqual(['fork-1', 'fork-1', 'parent-1', 'parent-1']);
    expect(metadataPatches[3]?.result).toEqual({});
    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('retains a dispatched fork when authority changes after the send', async () => {
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    sendMessageImpl = () => {
      assertOperationCurrentImpl = () => { throw new Error('runtime changed'); };
      return Promise.resolve();
    };
    let caught: unknown;

    try {
      await startBtwSession(startInput);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RetainedSessionError);
    if (!(caught instanceof RetainedSessionError)) throw caught;
    expect(caught.recovery.cause.message).toBe('runtime changed');
    expect(caught.recovery.compensationError.message).toBe('Prompt dispatch may have been accepted');
    expect(boundDeleteCalls).toEqual([]);
    expect(metadataPatches.map(({ sessionId }) => sessionId)).toEqual(['fork-1', 'fork-1', 'parent-1']);
    expect(publishedSessions).toEqual([]);
    expect(useBtwStore.getState().byParent).toEqual({
      'parent-1': { creating: true },
    });
  });

  test('returns typed retained recovery when failed-send rollback deletion is unconfirmed', async () => {
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/canonical/fork'));
    sendMessageImpl = () => Promise.reject(new Error('send failed'));
    deleteSessionImpl = () => Promise.resolve(false);
    let caught: unknown;
    try {
      await startBtwSession(startInput);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RetainedSessionError);
    if (!(caught instanceof RetainedSessionError)) throw caught;
    expect(caught.recovery.sessionID).toBe('fork-1');
    expect(caught.recovery.directory).toBe('/canonical/fork');
    expect(caught.recovery.runtimeKey).toBe('runtime-a');
    expect(caught.recovery.cause.message).toBe('send failed');
    expect(caught.recovery.compensationError.message).toBe('Failed to confirm removal of the BTW session');
  });

  test('returns typed retained recovery when failed-send rollback deletion throws', async () => {
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/canonical/fork'));
    sendMessageImpl = () => Promise.reject(new Error('send failed'));
    deleteSessionImpl = () => Promise.reject(new Error('bound delete failed'));
    let caught: unknown;
    try {
      await startBtwSession(startInput);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RetainedSessionError);
    if (!(caught instanceof RetainedSessionError)) throw caught;
    expect(caught.recovery.sessionID).toBe('fork-1');
    expect(caught.recovery.directory).toBe('/canonical/fork');
    expect(caught.recovery.compensationError.message).toBe('bound delete failed');
  });

  test('restores the previous BTW link when the replacement prompt fails', async () => {
    const previousBtwSession = { parentSessionId: 'parent-1', btwSessionId: 'fork-old', directory: '/project' };
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-old' } }],
      ['fork-old', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    const deleted: string[] = [];
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    sendMessageImpl = () => Promise.reject(new Error('send failed'));
    getSessionImpl = (sessionId, directory) => Promise.resolve({
      ...makeSession(sessionId, directory ?? '/project'),
      metadata: metadataBySession.get(sessionId) ?? {},
    });
    patchSessionMetadataImpl = (sessionId, _directory, updater) => {
      const result = updater(metadataBySession.get(sessionId) ?? {});
      metadataBySession.set(sessionId, result);
      metadataPatches.push({ sessionId, result });
      return Promise.resolve({ ...makeSession(sessionId), metadata: result });
    };
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    await expect(startBtwSession({ ...startInput, previousBtwSession })).rejects.toThrow('send failed');

    expect(metadataBySession.get('parent-1')).toEqual({ openchamber: { btwSessionID: 'fork-old' } });
    expect(deleted).toEqual(['fork-1']);
  });

  test('retires the previous BTW fork only after the replacement prompt succeeds', async () => {
    const previousBtwSession = { parentSessionId: 'parent-1', btwSessionId: 'fork-old', directory: '/project' };
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-old' } }],
      ['fork-old', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    const deleted: string[] = [];
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    getSessionImpl = (sessionId, directory) => Promise.resolve({
      ...makeSession(sessionId, directory ?? '/project'),
      metadata: metadataBySession.get(sessionId) ?? {},
    });
    patchSessionMetadataImpl = (sessionId, _directory, updater) => {
      const result = updater(metadataBySession.get(sessionId) ?? {});
      metadataBySession.set(sessionId, result);
      metadataPatches.push({ sessionId, result });
      return Promise.resolve({ ...makeSession(sessionId), metadata: result });
    };
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    await startBtwSession({ ...startInput, previousBtwSession });

    expect(metadataBySession.get('parent-1')).toEqual({ openchamber: { btwSessionID: 'fork-1' } });
    expect(deleted).toEqual(['fork-old']);
    expect(boundDeleteCalls).toEqual([{ sessionId: 'fork-old', directory: '/project' }]);
    expect(finalizedDeletionCalls).toEqual([{ sessionId: 'fork-old', directory: '/project' }]);
  });

  test('does not overwrite a concurrently changed BTW link', async () => {
    const previousBtwSession = { parentSessionId: 'parent-1', btwSessionId: 'fork-old', directory: '/project' };
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-newer' } }],
      ['fork-old', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    const deleted: string[] = [];
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    getSessionImpl = (sessionId, directory) => Promise.resolve({
      ...makeSession(sessionId, directory ?? '/project'),
      metadata: metadataBySession.get(sessionId) ?? {},
    });
    patchSessionMetadataImpl = (sessionId, _directory, updater) => {
      const result = updater(metadataBySession.get(sessionId) ?? {});
      metadataBySession.set(sessionId, result);
      metadataPatches.push({ sessionId, result });
      return Promise.resolve({ ...makeSession(sessionId), metadata: result });
    };
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    await expect(startBtwSession({ ...startInput, previousBtwSession })).rejects.toThrow('changed before replacement');

    expect(metadataBySession.get('parent-1')).toEqual({ openchamber: { btwSessionID: 'fork-newer' } });
    expect(deleted).toEqual(['fork-1']);
  });

  test('a failed boundary fetch deletes the fork', async () => {
    forkSessionWithAuthorizationImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    getSessionMessagesImpl = () => Promise.reject(new Error('messages failed'));
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    await expect(startBtwSession(startInput)).rejects.toThrow('messages failed');

    expect(deleted).toEqual(['fork-1']);
    expect(metadataPatches).toEqual([
      { sessionId: 'fork-1', result: { openchamber: { kind: 'btw', originalSessionID: 'parent-1', agent_backend: 'pi' } } },
    ]);
    expect(boundDeleteCalls).toEqual([{ sessionId: 'fork-1', directory: '/project' }]);
    expect(finalizedDeletionCalls).toEqual([]);
  });

  test('compensates an unlinked fork through its bound transport after the current transport changes', async () => {
    forkSessionWithAuthorizationImpl = async () => {
      assertOperationCurrentImpl = () => {
        throw new Error('transport changed');
      };
      return makeSession('fork-1', '/project');
    };

    await expect(startBtwSession(startInput)).rejects.toThrow('transport changed');

    expect(metadataPatches).toEqual([]);
    expect(publishedSessions).toEqual([]);
    expect(boundDeleteCalls).toEqual([{ sessionId: 'fork-1', directory: '/project' }]);
    expect(finalizedDeletionCalls).toEqual([]);
    expect(releaseCalls).toBe(1);
  });
});

describe('destroyBtwSession', () => {
  const ref = { parentSessionId: 'parent-1', btwSessionId: 'fork-1', directory: '/project' };

  test('unlinks through the bound operation before deleting and clearing the panel', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    installBtwMetadata(metadataBySession);
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    expect(await destroyBtwSession(ref)).toBe(true);

    expect(deleted).toEqual(['fork-1']);
    expect(boundDeleteCalls).toEqual([{ sessionId: 'fork-1', directory: '/project' }]);
    expect(deleteSessionCalls).toEqual([]);
    expect(metadataPatches).toEqual([{ sessionId: 'parent-1', result: {} }]);
    expect(metadataBySession.get('parent-1')).toEqual({});
    expect(finalizedDeletionCalls).toEqual([{ sessionId: 'fork-1', directory: '/project' }]);
    expect(useBtwStore.getState().byParent).toEqual({});
    expect(releaseCalls).toBe(1);
  });

  test('restores an unconfirmed fork link on the bound transport', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    installBtwMetadata(metadataBySession);
    deleteSessionImpl = () => Promise.resolve(false);

    expect(await destroyBtwSession(ref)).toBe(false);

    expect(metadataPatches).toEqual([
      { sessionId: 'parent-1', result: {} },
      { sessionId: 'parent-1', result: { openchamber: { btwSessionID: 'fork-1' } } },
    ]);
    expect(metadataBySession.get('parent-1')).toEqual({ openchamber: { btwSessionID: 'fork-1' } });
    expect(finalizedDeletionCalls).toEqual([]);
    expect(useBtwStore.getState().byParent).toEqual({
      'parent-1': { destroying: false },
    });
    expect(releaseCalls).toBe(1);
  });

  test('does not delete the fork when parent cleanup fails', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    installBtwMetadata(metadataBySession);
    patchSessionMetadataImpl = () => Promise.reject(new Error('patch failed'));
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    expect(await destroyBtwSession(ref)).toBe(false);

    expect(deleted).toEqual([]);
    expect(metadataBySession.get('parent-1')).toEqual({ openchamber: { btwSessionID: 'fork-1' } });
    expect(finalizedDeletionCalls).toEqual([]);
    expect(useBtwStore.getState().byParent).toEqual({
      'parent-1': { destroying: false },
    });
  });

  test('keeps the parent unlinked when authority changes after deletion', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    installBtwMetadata(metadataBySession);
    deleteSessionImpl = () => {
      assertOperationCurrentImpl = () => { throw new Error('runtime changed'); };
      return Promise.resolve(true);
    };

    expect(await destroyBtwSession(ref)).toBe(false);

    expect(metadataBySession.get('parent-1')).toEqual({});
    expect(finalizedDeletionCalls).toEqual([]);
    expect(publishedSessions).toEqual([]);
    expect(useBtwStore.getState().byParent).toEqual({
      'parent-1': { destroying: true },
    });
  });

  test('refuses to delete a linked fork after its BTW marker is gone', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', {}],
    ]);
    installBtwMetadata(metadataBySession);
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    expect(await destroyBtwSession(ref)).toBe(false);

    expect(deleted).toEqual([]);
    expect(metadataPatches).toEqual([]);
  });
});

describe('promoteBtwSession', () => {
  const ref = { parentSessionId: 'parent-1', btwSessionId: 'fork-1', directory: '/project' };

  test('confirms marker cleanup, then unlinks and navigates to the promoted fork', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', { openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-1' } }],
    ]);
    installBtwMetadata(metadataBySession);

    await promoteBtwSession(ref);

    expect(metadataPatches).toEqual([
      { sessionId: 'fork-1', result: {} },
      { sessionId: 'parent-1', result: {} },
    ]);
    expect(publishedSessions.map(({ session }) => session.id)).toEqual(['fork-1', 'parent-1']);
    expect(currentSessionSwitches).toEqual(['fork-1']);
    expect(releaseCalls).toBe(1);
  });

  test('keeps the existing panel state when marker cleanup fails', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    installBtwMetadata(metadataBySession);
    useBtwStore.setState({ byParent: { 'parent-1': { collapsed: true } } });
    patchSessionMetadataImpl = () => Promise.reject(new Error('patch failed'));

    await expect(promoteBtwSession(ref)).rejects.toThrow('patch failed');

    expect(metadataPatches).toEqual([]);
    expect(currentSessionSwitches).toEqual([]);
    expect(useBtwStore.getState().byParent).toEqual({
      'parent-1': { collapsed: true },
    });
    expect(releaseCalls).toBe(1);
  });

  test('restores the marker when parent unlinking fails after promotion starts', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', { openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-1', agent_backend: 'pi' } }],
    ]);
    installBtwMetadata(metadataBySession);
    const patch = patchSessionMetadataImpl;
    patchSessionMetadataImpl = (sessionId, directory, updater) => {
      if (sessionId === 'parent-1') return Promise.reject(new Error('unlink failed'));
      return patch(sessionId, directory, updater);
    };

    await expect(promoteBtwSession(ref)).rejects.toThrow('unlink failed');

    expect(metadataBySession.get('parent-1')).toEqual({ openchamber: { btwSessionID: 'fork-1' } });
    expect(metadataBySession.get('fork-1')).toEqual({
      openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-1', agent_backend: 'pi' },
    });
    expect(metadataPatches).toEqual([
      { sessionId: 'fork-1', result: { openchamber: { agent_backend: 'pi' } } },
      { sessionId: 'fork-1', result: { openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-1', agent_backend: 'pi' } } },
    ]);
    expect(publishedSessions).toEqual([]);
    expect(currentSessionSwitches).toEqual([]);
  });

  test('completes unlinking on the bound transport after authority changes mid-promote', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', { openchamber: { kind: 'btw', originalSessionID: 'parent-1' } }],
    ]);
    installBtwMetadata(metadataBySession);
    const patch = patchSessionMetadataImpl;
    patchSessionMetadataImpl = async (sessionId, directory, updater) => {
      const result = await patch(sessionId, directory, updater);
      if (sessionId === 'fork-1') {
        assertOperationCurrentImpl = () => { throw new Error('runtime changed'); };
      }
      return result;
    };

    await expect(promoteBtwSession(ref)).rejects.toThrow('runtime changed');

    expect(metadataBySession.get('parent-1')).toEqual({});
    expect(metadataBySession.get('fork-1')).toEqual({});
    expect(publishedSessions).toEqual([]);
    expect(currentSessionSwitches).toEqual([]);
    expect(releaseCalls).toBe(1);
  });

  test('refuses to promote an unmarked linked fork', async () => {
    const metadataBySession = new Map<string, SessionMetadataRecord>([
      ['parent-1', { openchamber: { btwSessionID: 'fork-1' } }],
      ['fork-1', {}],
    ]);
    installBtwMetadata(metadataBySession);

    await expect(promoteBtwSession(ref)).rejects.toThrow('no longer active');

    expect(metadataPatches).toEqual([]);
    expect(currentSessionSwitches).toEqual([]);
  });
});
