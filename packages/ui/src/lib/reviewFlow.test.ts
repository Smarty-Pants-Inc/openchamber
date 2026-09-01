import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2/client';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from './runtime-switch';
import { withAgentBackendMetadata } from './sessionReviewMetadata';
import type { SessionMetadataRecord } from './sessionReviewMetadata';
import type { AutoReviewRun } from '@/stores/useAutoReviewStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

type ReviewLinkRequest = {
  path: string;
  expectedReviewSessionId: string | null;
  replacementReviewSessionId: string | null;
  directory: string | null;
};

const reviewLinkRequests: ReviewLinkRequest[] = [];
let reviewLinkFetchImpl: (path: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error('review-link fixture is not installed');
};
const runtimeFetchMock = mock((path: string, init?: RequestInit) => reviewLinkFetchImpl(path, init));

const boundTransportRequests: Array<{ url: string; body: unknown }> = [];
let boundTransportFetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error('bound transport fixture is not installed');
};
let boundTransportReleaseCount = 0;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
  bindRuntimeTransport: () => ({
    apiBaseUrl: 'http://runtime-a.test/api',
    fetch: (input: string | URL | Request, init?: RequestInit) => boundTransportFetchImpl(input, init),
    release: () => { boundTransportReleaseCount += 1; },
  }),
}));

mock.module('@/lib/magicPrompts', () => ({
  renderMagicPrompt: async (key: string) => key,
}));

// Keep real exports available to transitive sync imports while this test swaps
// only the transport-bound methods consumed by the review flow modules.
const actualSessionActions = await import('@/sync/session-actions');

type ReviewOptimisticSendInput = Parameters<typeof actualSessionActions.optimisticSend>[0];
const optimisticSendCalls: ReviewOptimisticSendInput[] = [];
let optimisticSendImpl = async (input: ReviewOptimisticSendInput): Promise<void> => {
  optimisticSendCalls.push(input);
  input.onMessageID?.('message-sent');
};

class TestBoundSessionOperationError extends Error {
  readonly status?: number;

  constructor(operation: string, status?: number) {
    super(`${operation} failed`);
    this.name = 'BoundSessionOperationError';
    this.status = status;
  }
}

type ReviewBoundOperation = {
  runtimeKey: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  create: (params?: ReviewCreateSessionParams, directory?: ReviewCreateSessionDirectory) => Promise<Session>;
  get: (sessionID: string, directory?: string | null) => Promise<Session>;
  delete: (sessionID: string, directory?: string | null) => Promise<boolean>;
  assertCurrent: () => void;
  release: () => void;
};

let boundOperationFactory: () => ReviewBoundOperation = () => {
  throw new Error('bound review transport fixture is not installed');
};

mock.module('@/sync/session-actions', () => ({
  ...actualSessionActions,
  BoundSessionOperationError: TestBoundSessionOperationError,
  bindSessionOperation: () => boundOperationFactory(),
  finalizeConfirmedSessionDeletion: () => undefined,
  optimisticSend: (input: ReviewOptimisticSendInput) => optimisticSendImpl(input),
  patchSessionMetadata: async () => {
    throw new Error('metadata patch fixture is not installed');
  },
  waitForConnectionOrThrow: async () => undefined,
}));

// Dynamic imports follow the transport mocks above.
const {
  assertAutoReviewRuntimeStillCurrent,
  claimAutoReviewForward,
  getOptimisticTextPartID,
  releaseAutoReviewForward,
  hasFinalReviewMarker,
  isAutoReviewRuntimeCurrent,
  isExpectedAutoReviewAssistantParent,
  sendImplementationResponseToReviewer,
  sendReviewFeedbackToOriginal,
  stripFinalReviewMarker,
} = await import('./reviewFlow');
const {
  createOrReuseReviewSession,
  ReviewSessionRetainedError,
} = await import('./reviewSessionLifecycle');

describe('reviewFlow auto-review helpers', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
  });

  test('forwards the optimistic review prompt text-part identity', () => {
    const parts = [
      { id: 'prt_review_prompt', type: 'text', text: 'Review the implementation.' },
    ] as Part[];

    expect(getOptimisticTextPartID(parts)).toBe('prt_review_prompt');
  });

  test('detects and strips final review marker only from the final line', () => {
    const text = 'No remaining issues.\n\nFINAL_REVIEW_STATUS: no_remaining_findings\n';

    expect(hasFinalReviewMarker(text)).toBe(true);
    expect(stripFinalReviewMarker(text)).toBe('No remaining issues.');
  });

  test('detects and strips final review marker case-insensitively', () => {
    const text = 'No findings.\nFINAL_REVIEW_STATUS: no_remaining_findINGS\n';

    expect(hasFinalReviewMarker(text)).toBe(true);
    expect(stripFinalReviewMarker(text)).toBe('No findings.');
  });

  test('does not treat quoted or non-final marker text as completion', () => {
    const text = 'The marker is FINAL_REVIEW_STATUS: no_remaining_findings, but issues remain.';

    expect(hasFinalReviewMarker(text)).toBe(false);
    expect(stripFinalReviewMarker(text)).toBe(text);
  });

  test('requires assistant parent to match the auto-sent user message when provided', () => {
    const matching = { id: 'msg_assistant_1', parentID: 'msg_user_auto' } as Message;
    const unrelated = { id: 'msg_assistant_2', parentID: 'msg_user_manual' } as Message;

    expect(isExpectedAutoReviewAssistantParent(matching, 'msg_user_auto')).toBe(true);
    expect(isExpectedAutoReviewAssistantParent(unrelated, 'msg_user_auto')).toBe(false);
    expect(isExpectedAutoReviewAssistantParent(unrelated)).toBe(true);
  });

  test('runtime guard rejects runs from a stale runtime', () => {
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(true);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(false);
    expect(() => assertAutoReviewRuntimeStillCurrent('runtime-a')).toThrow('runtime changed');
  });

  test('claims only one in-flight forward for the same auto-review message', () => {
    const run: AutoReviewRun = {
      originalSessionID: 'original-1',
      reviewSessionID: 'review-1',
      directory: '/workspace',
      runtimeKey: 'runtime-a',
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 0,
      maxIterations: 15,
      expectedAssistantParentID: 'msg_user_prompt',
    };

    const key = claimAutoReviewForward(run, 'msg_assistant_review');

    expect(typeof key).toBe('string');
    expect(claimAutoReviewForward(run, 'msg_assistant_review')).toBeNull();

    releaseAutoReviewForward(key!);
    const nextKey = claimAutoReviewForward(run, 'msg_assistant_review');
    expect(nextKey).toBe(key);
    releaseAutoReviewForward(nextKey!);
  });
});

type TestOpenChamberMetadata = {
  reviewSessionID?: string;
  kind?: 'review';
  originalSessionID?: string;
  agent_backend?: unknown;
};
type TestSessionMetadata = SessionMetadataRecord & { openchamber?: TestOpenChamberMetadata };
type ReviewCreateSessionParams = Parameters<typeof opencodeClient.createSession>[0];
type ReviewCreateSessionDirectory = Parameters<typeof opencodeClient.createSession>[1];
const reviewLinkRequestSchema = z.object({
  directory: z.string(),
  expectedReviewSessionId: z.string().nullable(),
  replacementReviewSessionId: z.string().nullable(),
});
const testErrorSchema = z.instanceof(Error);


const makeSession = (
  id: string,
  metadata: SessionMetadataRecord = {},
  directory: string | null = '/workspace',
): Session => {
  // SAFETY: The fixture supplies every required SDK Session field; undefined directory intentionally models a malformed create response.
  return {
    id,
    slug: id,
    projectID: 'project',
    directory: directory ?? undefined,
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
    metadata,
  } as Session;
};

const getTestSessionMetadata = (session: Session): TestSessionMetadata => {
  // SAFETY: Test fixtures exclusively populate this in-process metadata shape.
  const candidate = session as Session & { metadata?: TestSessionMetadata };
  return candidate.metadata ?? {};
};

const getLinkedReviewID = (session: Session | undefined): string | undefined => (
  session ? getTestSessionMetadata(session).openchamber?.reviewSessionID : undefined
);

const originalClientMethods = {
  createSession: opencodeClient.createSession,
  getSession: opencodeClient.getSession,
  sendMessage: opencodeClient.sendMessage,
};

afterEach(() => {
  opencodeClient.createSession = originalClientMethods.createSession;
  opencodeClient.getSession = originalClientMethods.getSession;
  opencodeClient.sendMessage = originalClientMethods.sendMessage;
  boundOperationFactory = () => {
    throw new Error('bound review transport fixture is not installed');
  };
  optimisticSendCalls.length = 0;
  optimisticSendImpl = async (input) => {
    optimisticSendCalls.push(input);
    input.onMessageID?.('message-sent');
  };
  reviewLinkRequests.length = 0;
  boundTransportRequests.length = 0;
  boundTransportFetchImpl = async () => {
    throw new Error('bound transport fixture is not installed');
  };
  boundTransportReleaseCount = 0;
  useGlobalSessionsStore.getState().applySnapshot([], []);
  useConfigStore.setState({ currentProviderId: '', currentModelId: '', currentAgentName: undefined });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
});

type ReviewTransactionOptions = {
  existingBackend?: 'omp' | 'pi' | 'native' | 'unknown';
  originalDirectory?: string;
  oldReviewDirectory?: string;
  createdDirectory?: string | null;
  failReplacementLink?: boolean;
  failOldDelete?: boolean;
  failNewDelete?: boolean;
  returnFalseForNewDelete?: boolean;
  oldDeleteNotFound?: boolean;
  switchRuntimeDuringOldDelete?: boolean;
  switchRuntimeDuringOldCleanupCheck?: boolean;
  switchTransportDuringCreate?: boolean;
  switchTransportDuringOldDelete?: boolean;
  switchRuntimeDuringReplacementLink?: boolean;
  replaceLinkDuringOldDelete?: boolean;
  indexOldReview?: boolean;
  omitOldReviewDirectoryInResponse?: boolean;
};

const installReviewTransactionClient = (options: ReviewTransactionOptions = {}) => {
  const originalDirectory = options.originalDirectory ?? '/workspace';
  const oldReviewDirectory = options.oldReviewDirectory ?? originalDirectory;
  const existingBackend = options.existingBackend ?? 'omp';
  const oldOpenChamber: TestOpenChamberMetadata = {
    kind: 'review',
    originalSessionID: 'original-transaction',
  };
  if (existingBackend === 'omp' || existingBackend === 'pi') {
    oldOpenChamber.agent_backend = existingBackend;
  } else if (existingBackend === 'unknown') {
    oldOpenChamber.agent_backend = 'legacy';
  }

  const sessions = new Map<string, Session>([
    ['original-transaction', makeSession('original-transaction', {
      openchamber: { reviewSessionID: 'review-old' },
    }, originalDirectory)],
    ['review-old', makeSession('review-old', {
      openchamber: oldOpenChamber,
    }, oldReviewDirectory)],
  ]);
  useGlobalSessionsStore.getState().applySnapshot(
    options.indexOldReview === false
      ? [sessions.get('original-transaction')!]
      : Array.from(sessions.values()),
    [],
  );
  const events: string[] = [];
  const createCalls: Array<{
    params: ReviewCreateSessionParams;
    directory: ReviewCreateSessionDirectory;
  }> = [];
  const getCalls: Array<{ sessionID: string; directory?: string | null }> = [];
  const deleteCalls: Array<{ sessionID: string; directory?: string | null }> = [];
  let nextReviewNumber = 0;
  let transportCurrent = true;
  let switchedRuntimeDuringOldCleanupCheck = false;
  let released = false;

  const get = async (sessionID: string, directory?: string | null): Promise<Session> => {
    getCalls.push({ sessionID, directory });
    const value = sessions.get(sessionID);
    if (!value || directory !== value.directory) {
      throw new TestBoundSessionOperationError('session.get', 404);
    }
    if (
      options.switchRuntimeDuringOldCleanupCheck
      && !switchedRuntimeDuringOldCleanupCheck
      && sessionID === 'original-transaction'
      && getLinkedReviewID(value) === 'review-new-1'
    ) {
      switchedRuntimeDuringOldCleanupCheck = true;
      switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    }
    if (options.omitOldReviewDirectoryInResponse && sessionID === 'review-old') {
      const response = { ...value };
      Reflect.deleteProperty(response, 'directory');
      return response;
    }
    return value;
  };
  const deleteSession = async (sessionID: string, directory?: string | null): Promise<boolean> => {
    deleteCalls.push({ sessionID, directory });
    events.push(`delete:${sessionID}`);
    const value = sessions.get(sessionID);
    if (!value || directory !== value.directory) {
      throw new TestBoundSessionOperationError('session.delete', 404);
    }
    if (options.switchRuntimeDuringOldDelete && sessionID === 'review-old') {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    }
    if (options.switchTransportDuringOldDelete && sessionID === 'review-old') transportCurrent = false;
    if (options.replaceLinkDuringOldDelete && sessionID === 'review-old') {
      const original = sessions.get('original-transaction');
      if (!original) throw new Error('missing original session');
      sessions.set('review-concurrent', makeSession('review-concurrent', {
        openchamber: { kind: 'review', originalSessionID: 'original-transaction', agent_backend: 'pi' },
      }, originalDirectory));
      sessions.set('original-transaction', {
        ...original,
        metadata: { openchamber: { reviewSessionID: 'review-concurrent' } },
      });
    }
    if (options.failOldDelete && sessionID === 'review-old') {
      if (options.oldDeleteNotFound) {
        sessions.delete(sessionID);
        throw new TestBoundSessionOperationError('session.delete', 404);
      }
      throw new TestBoundSessionOperationError('session.delete');
    }
    if (sessionID.startsWith('review-new-')) {
      if (options.failNewDelete) throw new TestBoundSessionOperationError('session.delete');
      if (options.returnFalseForNewDelete) return false;
    }
    sessions.delete(sessionID);
    return true;
  };
  const create = async (
    params?: ReviewCreateSessionParams,
    directory?: ReviewCreateSessionDirectory,
  ): Promise<Session> => {
    if (directory !== originalDirectory) throw new TestBoundSessionOperationError('session.create', 404);
    createCalls.push({ params, directory });
    const id = `review-new-${++nextReviewNumber}`;
    events.push(`create:${id}`);
    const metadata = withAgentBackendMetadata(params?.metadata, params?.providerID ?? '') ?? {};
    const createdDirectory = options.createdDirectory ?? directory ?? null;
    const created = makeSession(id, metadata, createdDirectory);
    sessions.set(created.id, created);
    if (options.switchTransportDuringCreate) transportCurrent = false;
    if (options.createdDirectory === null) {
      const response = { ...created };
      Reflect.deleteProperty(response, 'directory');
      return response;
    }
    return created;
  };

  boundOperationFactory = () => ({
    runtimeKey: 'runtime-a',
    request: runtimeFetchMock,
    create,
    get,
    delete: deleteSession,
    assertCurrent: () => {
      if (!transportCurrent) throw new Error('runtime changed');
    },
    release: () => {
      released = true;
    },
  });
  opencodeClient.createSession = mock(async (): Promise<Session> => {
    throw new Error('review transaction used the mutable global client');
  });
  reviewLinkFetchImpl = async (path, init) => {
    const payload = reviewLinkRequestSchema.parse(JSON.parse(String(init?.body ?? '{}')));
    const { directory, expectedReviewSessionId, replacementReviewSessionId } = payload;
    reviewLinkRequests.push({ path, expectedReviewSessionId, replacementReviewSessionId, directory });
    events.push(`link:${replacementReviewSessionId ?? 'none'}`);
    if (directory !== originalDirectory) {
      return new Response(JSON.stringify({ error: 'session not found in directory' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (options.failReplacementLink) {
      return new Response(JSON.stringify({ error: 'replacement link failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const original = sessions.get('original-transaction');
    if (!original) throw new Error('missing original session');
    if ((getLinkedReviewID(original) ?? null) !== expectedReviewSessionId) {
      return new Response(JSON.stringify({ replaced: false, session: original }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const currentMetadata = getTestSessionMetadata(original);
    const openchamber = { ...(currentMetadata.openchamber ?? {}) };
    if (replacementReviewSessionId) openchamber.reviewSessionID = replacementReviewSessionId;
    else delete openchamber.reviewSessionID;
    const updated = {
      ...original,
      metadata: { ...currentMetadata, openchamber },
    };
    sessions.set(original.id, updated);
    if (options.switchRuntimeDuringReplacementLink) {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    }
    return new Response(JSON.stringify({ replaced: true, session: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { sessions, events, createCalls, getCalls, deleteCalls, isReleased: () => released };
};

const captureFailure = async (promise: Promise<unknown>): Promise<Error | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return testErrorSchema.parse(error);
  }
};

describe('reviewSessionLifecycle replacement transaction', () => {
  test('uses the bound create and each session authoritative directory', async () => {
    const { sessions, events, createCalls, getCalls, deleteCalls } = installReviewTransactionClient({
      originalDirectory: '/canonical/original',
      oldReviewDirectory: '/canonical/old-review',
      createdDirectory: '/canonical/new-review',
    });

    const review = await createOrReuseReviewSession('original-transaction', '/canonical/original', 'pi');

    expect(review.id).toBe('review-new-1');
    expect(createCalls).toEqual([{
      directory: '/canonical/original',
      params: {
        title: 'Review: original-transaction',
        providerID: 'pi',
        metadata: { openchamber: { kind: 'review', originalSessionID: 'original-transaction' } },
      },
    }]);
    expect(getCalls.slice(0, 2)).toEqual([
      { sessionID: 'original-transaction', directory: '/canonical/original' },
      { sessionID: 'review-old', directory: '/canonical/old-review' },
    ]);
    expect(reviewLinkRequests).toEqual([{
      path: '/api/openchamber/sessions/original-transaction/review-link',
      expectedReviewSessionId: 'review-old',
      replacementReviewSessionId: 'review-new-1',
      directory: '/canonical/original',
    }]);
    expect(deleteCalls.some((call) => (
      call.sessionID === 'review-old' && call.directory === '/canonical/old-review'
    ))).toBe(true);
    expect(events).toEqual(['create:review-new-1', 'link:review-new-1', 'delete:review-old']);
    expect(sessions.has('review-old')).toBe(false);
  });

  test('reuses only an exact Pi review', async () => {
    const { events } = installReviewTransactionClient({ existingBackend: 'pi' });
    const review = await createOrReuseReviewSession('original-transaction', '/workspace', 'pi');
    expect(review.id).toBe('review-old');
    expect(events).toEqual([]);
  });

  test('preserves the authoritative index directory when a reused response omits it', async () => {
    installReviewTransactionClient({
      existingBackend: 'pi',
      originalDirectory: '/canonical/original',
      oldReviewDirectory: '/canonical/review',
      omitOldReviewDirectoryInResponse: true,
    });

    const review = await createOrReuseReviewSession('original-transaction', '/canonical/original', 'pi');

    expect(review.id).toBe('review-old');
    expect(review.directory).toBe('/canonical/review');
  });

  test('fails closed when a linked review has no authoritative directory', async () => {
    const { createCalls, deleteCalls, getCalls } = installReviewTransactionClient({ indexOldReview: false });

    await expect(createOrReuseReviewSession('original-transaction', '/workspace', 'pi'))
      .rejects.toThrow('Review session directory is unavailable');

    expect(getCalls).toEqual([{ sessionID: 'original-transaction', directory: '/workspace' }]);
    expect(createCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });

  test('reuses an unmarked review only for a native backend without stamping it', async () => {
    const { events } = installReviewTransactionClient({ existingBackend: 'native' });
    const review = await createOrReuseReviewSession('original-transaction', '/workspace', 'anthropic');
    const metadata = getTestSessionMetadata(review);
    expect(review.id).toBe('review-old');
    expect(metadata?.openchamber?.agent_backend).toBe(undefined);
    expect(events).toEqual([]);
  });

  test('does not reuse a managed review for native creation', async () => {
    const { createCalls } = installReviewTransactionClient({ existingBackend: 'omp' });
    const review = await createOrReuseReviewSession('original-transaction', '/workspace', 'anthropic');
    const metadata = getTestSessionMetadata(review);
    expect(review.id).toBe('review-new-1');
    expect(metadata?.openchamber?.agent_backend).toBe(undefined);
    expect(createCalls).toHaveLength(1);
  });

  test('does not reuse an unmarked native review for OMP creation', async () => {
    installReviewTransactionClient({ existingBackend: 'native' });
    const review = await createOrReuseReviewSession('original-transaction', '/workspace', 'omp');
    const metadata = getTestSessionMetadata(review);
    expect(review.id).toBe('review-new-1');
    expect(metadata?.openchamber?.agent_backend).toBe('omp');
  });

  test('does not treat an invalid persisted backend marker as native', async () => {
    installReviewTransactionClient({ existingBackend: 'unknown' });
    const review = await createOrReuseReviewSession('original-transaction', '/workspace', 'anthropic');
    expect(review.id).toBe('review-new-1');
  });

  test('returns the server CAS winner and removes the losing concurrent replacement', async () => {
    const { sessions, events } = installReviewTransactionClient();
    const [first, second] = await Promise.all([
      createOrReuseReviewSession('original-transaction', '/workspace', 'pi'),
      createOrReuseReviewSession('original-transaction', '/workspace', 'pi'),
    ]);
    expect(first.id).toBe(second.id);
    expect(reviewLinkRequests).toHaveLength(2);
    expect(events.filter((event) => event.startsWith('create:'))).toHaveLength(2);
    expect(events).toContain('delete:review-old');
    expect(events).toContain('delete:review-new-2');
    expect(sessions.has('review-new-2')).toBe(false);
  });

  test('deletes a rejected replacement in its returned directory', async () => {
    const { sessions, deleteCalls } = installReviewTransactionClient({
      failReplacementLink: true,
      createdDirectory: '/canonical/new-review',
    });
    await expect(createOrReuseReviewSession('original-transaction', '/workspace', 'pi'))
      .rejects.toThrow('session.review-link failed');
    expect(deleteCalls.some((call) => (
      call.sessionID === 'review-new-1' && call.directory === '/canonical/new-review'
    ))).toBe(true);
    expect(sessions.has('review-new-1')).toBe(false);
  });

  test('returns typed retained recovery when rejected replacement cleanup throws', async () => {
    installReviewTransactionClient({
      failReplacementLink: true,
      failNewDelete: true,
      createdDirectory: '/canonical/new-review',
    });
    const error = await captureFailure(createOrReuseReviewSession('original-transaction', '/workspace', 'pi'));
    expect(error).toBeInstanceOf(ReviewSessionRetainedError);
    if (!(error instanceof ReviewSessionRetainedError)) throw error;
    expect(error.recovery.sessionID).toBe('review-new-1');
    expect(error.recovery.directory).toBe('/canonical/new-review');
    expect(error.recovery.runtimeKey).toBe('runtime-a');
    expect(error.recovery.cause.message).toBe('session.review-link failed');
    expect(error.recovery.compensationError.message).toBe('session.delete failed');
  });

  test('returns typed retained recovery when deletion is not confirmed', async () => {
    installReviewTransactionClient({
      failReplacementLink: true,
      returnFalseForNewDelete: true,
      createdDirectory: '/canonical/new-review',
    });
    const error = await captureFailure(createOrReuseReviewSession('original-transaction', '/workspace', 'pi'));
    expect(error).toBeInstanceOf(ReviewSessionRetainedError);
    if (!(error instanceof ReviewSessionRetainedError)) throw error;
    expect(error.recovery.sessionID).toBe('review-new-1');
    expect(error.recovery.directory).toBe('/canonical/new-review');
  });

  test('preserves typed recovery when old-review cleanup fails', async () => {
    const { sessions } = installReviewTransactionClient({
      failOldDelete: true,
      oldReviewDirectory: '/canonical/old-review',
    });
    const error = await captureFailure(createOrReuseReviewSession('original-transaction', '/workspace', 'pi'));
    expect(error).toBeInstanceOf(ReviewSessionRetainedError);
    if (!(error instanceof ReviewSessionRetainedError)) throw error;
    expect(error.recovery.sessionID).toBe('review-old');
    expect(error.recovery.directory).toBe('/canonical/old-review');
    expect(error.recovery.compensationError.message).toBe('session.delete failed');
    expect(sessions.has('review-old')).toBe(true);
    expect(getLinkedReviewID(sessions.get('original-transaction'))).toBe('review-new-1');
  });

  test('treats an old-review delete 404 as success after confirming it is absent', async () => {
    const { sessions } = installReviewTransactionClient({ failOldDelete: true, oldDeleteNotFound: true });
    const review = await createOrReuseReviewSession('original-transaction', '/workspace', 'pi');
    expect(review.id).toBe('review-new-1');
    expect(sessions.has('review-old')).toBe(false);
  });

  test('deletes an unlinked replacement when its transport changes during creation', async () => {
    const { sessions, events } = installReviewTransactionClient({ switchTransportDuringCreate: true });
    await expect(createOrReuseReviewSession('original-transaction', '/workspace', 'pi', 'runtime-a'))
      .rejects.toThrow('runtime changed');
    expect(events).toEqual(['create:review-new-1', 'delete:review-new-1']);
    expect(sessions.has('review-new-1')).toBe(false);
  });

  test('uses the original directory fallback to clean a directory-less created replacement', async () => {
    const { deleteCalls, sessions } = installReviewTransactionClient({
      createdDirectory: null,
      failReplacementLink: true,
      originalDirectory: '/canonical/original',
    });

    await expect(createOrReuseReviewSession('original-transaction', '/canonical/original', 'pi'))
      .rejects.toThrow('session.review-link failed');

    expect(deleteCalls.some((call) => (
      call.sessionID === 'review-new-1' && call.directory === '/canonical/original'
    ))).toBe(true);
    expect(sessions.has('review-new-1')).toBe(false);
  });

  test('returns the original directory when a created review response omits it', async () => {
    installReviewTransactionClient({
      createdDirectory: null,
      originalDirectory: '/canonical/original',
    });

    const review = await createOrReuseReviewSession('original-transaction', '/canonical/original', 'pi');

    expect(review.directory).toBe('/canonical/original');
  });

  test('confirms and cleans the old review on retained transport after a stale link response', async () => {
    const { deleteCalls, events, sessions } = installReviewTransactionClient({
      switchRuntimeDuringReplacementLink: true,
    });

    await expect(createOrReuseReviewSession('original-transaction', '/workspace', 'pi', 'runtime-a'))
      .rejects.toThrow('runtime changed');

    expect(getLinkedReviewID(sessions.get('original-transaction'))).toBe('review-new-1');
    expect(sessions.has('review-old')).toBe(false);
    expect(deleteCalls.some((call) => call.sessionID === 'review-old' && call.directory === '/workspace')).toBe(true);
    expect(events).toEqual(['create:review-new-1', 'link:review-new-1', 'delete:review-old']);
  });

  test('cleans the old review when staleness occurs before its deletion attempt', async () => {
    const { events, sessions } = installReviewTransactionClient({
      switchRuntimeDuringOldCleanupCheck: true,
    });

    await expect(createOrReuseReviewSession('original-transaction', '/workspace', 'pi', 'runtime-a'))
      .rejects.toThrow('runtime changed');

    expect(sessions.has('review-old')).toBe(false);
    expect(events).toEqual(['create:review-new-1', 'link:review-new-1', 'delete:review-old']);
  });

  test('keeps typed retained recovery when stale link reconciliation cannot clean the old review', async () => {
    installReviewTransactionClient({
      failOldDelete: true,
      oldReviewDirectory: '/canonical/old-review',
      switchRuntimeDuringReplacementLink: true,
    });

    const error = await captureFailure(createOrReuseReviewSession('original-transaction', '/workspace', 'pi', 'runtime-a'));

    expect(error).toBeInstanceOf(ReviewSessionRetainedError);
    if (!(error instanceof ReviewSessionRetainedError)) throw error;
    expect(error.recovery.sessionID).toBe('review-old');
    expect(error.recovery.directory).toBe('/canonical/old-review');
    expect(error.recovery.cause.message).toBe('Auto-review stopped because the runtime changed.');
    expect(error.recovery.compensationError.message).toBe('session.delete failed');
  });

  test('does not compensate a replacement that is already linked when the runtime changes', async () => {
    const { sessions, events } = installReviewTransactionClient({ switchRuntimeDuringOldDelete: true });
    await expect(createOrReuseReviewSession('original-transaction', '/workspace', 'pi', 'runtime-a'))
      .rejects.toThrow('runtime changed');
    expect(events).toEqual(['create:review-new-1', 'link:review-new-1', 'delete:review-old']);
    expect(sessions.has('review-new-1')).toBe(true);
    expect(getLinkedReviewID(sessions.get('original-transaction'))).toBe('review-new-1');
  });

  test('does not compensate a linked replacement after same-runtime transport replacement', async () => {
    const { sessions, events } = installReviewTransactionClient({ switchTransportDuringOldDelete: true });
    await expect(createOrReuseReviewSession('original-transaction', '/workspace', 'pi', 'runtime-a'))
      .rejects.toThrow('runtime changed');
    expect(events).toEqual(['create:review-new-1', 'link:review-new-1', 'delete:review-old']);
    expect(sessions.has('review-new-1')).toBe(true);
  });

  test('reports retained old cleanup after a concurrent link wins and removes the losing replacement', async () => {
    const { sessions, events } = installReviewTransactionClient({
      failOldDelete: true,
      replaceLinkDuringOldDelete: true,
    });
    const error = await captureFailure(createOrReuseReviewSession('original-transaction', '/workspace', 'pi'));
    expect(error).toBeInstanceOf(ReviewSessionRetainedError);
    if (!(error instanceof ReviewSessionRetainedError)) throw error;
    expect(error.recovery.sessionID).toBe('review-old');
    expect(events).toEqual(['create:review-new-1', 'link:review-new-1', 'delete:review-old', 'delete:review-new-1']);
    expect(getLinkedReviewID(sessions.get('original-transaction'))).toBe('review-concurrent');
    expect(sessions.has('review-new-1')).toBe(false);
  });
});

describe('reviewFlow linked counterpart routing', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
    useConfigStore.setState({
      currentProviderId: 'pi',
      currentModelId: 'model',
      currentAgentName: undefined,
    });
  });

  test('gets and sends review feedback in the original session authoritative directory', async () => {
    const original = makeSession('original-feedback', {}, '/canonical/original');
    const review = makeSession('review-feedback', {
      openchamber: { kind: 'review', originalSessionID: original.id, agent_backend: 'pi' },
    }, '/canonical/review');
    const sessions = new Map([[original.id, original], [review.id, review]]);
    useGlobalSessionsStore.getState().applySnapshot([original, review], []);
    const getCalls: Array<{ sessionID: string; directory?: string | null }> = [];
    opencodeClient.getSession = mock(async (sessionID: string, directory?: string | null): Promise<Session> => {
      getCalls.push({ sessionID, directory });
      const session = sessions.get(sessionID);
      if (!session || directory !== session.directory) {
        throw new Error('session.get failed (404)');
      }
      return session;
    });

    await sendReviewFeedbackToOriginal(review.id, '/canonical/review', 'fix this', 'runtime-a');

    expect(getCalls).toEqual([
      { sessionID: review.id, directory: '/canonical/review' },
      { sessionID: original.id, directory: '/canonical/original' },
    ]);
    expect(optimisticSendCalls.map(({ sessionId, directory }) => ({ sessionId, directory }))).toEqual([
      { sessionId: original.id, directory: '/canonical/original' },
    ]);
  });

  test('rechecks and passes captured runtime authority after send preflight', async () => {
    const original = makeSession('original-preflight', {}, '/canonical/original');
    const review = makeSession('review-preflight', {
      openchamber: { kind: 'review', originalSessionID: original.id, agent_backend: 'pi' },
    }, '/canonical/review');
    const sessions = new Map([[original.id, original], [review.id, review]]);
    useGlobalSessionsStore.getState().applySnapshot([original, review], []);
    opencodeClient.getSession = mock(async (sessionID: string, directory?: string | null): Promise<Session> => {
      const session = sessions.get(sessionID);
      if (!session || directory !== session.directory) throw new Error('session.get failed (404)');
      return session;
    });
    optimisticSendImpl = async (input) => {
      optimisticSendCalls.push(input);
      input.onMessageID?.('message-sent');
      await input.send('message-sent', []);
    };
    let switchDuringPreflight = false;
    let switchDuringPromptDispatch = false;
    boundTransportFetchImpl = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      boundTransportRequests.push({ url, body: rawBody ? JSON.parse(String(rawBody)) : null });
      if (url.includes('/send-preflight')) {
        if (switchDuringPreflight) {
          switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
        }
        return new Response(JSON.stringify({ authorized: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/prompt_async')) {
        if (switchDuringPromptDispatch) {
          switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
        }
        return new Response(JSON.stringify(true), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected bound request: ${url}`);
    };

    await sendReviewFeedbackToOriginal(review.id, '/canonical/review', 'fix this', 'runtime-a');
    expect(boundTransportRequests.map(({ url }) => url)).toEqual([
      '/api/openchamber/sessions/original-preflight/send-preflight',
      'http://runtime-a.test/api/session/original-preflight/prompt_async?directory=%2Fcanonical%2Foriginal',
    ]);

    switchDuringPreflight = true;
    await expect(sendReviewFeedbackToOriginal(
      review.id,
      '/canonical/review',
      'fix this',
      'runtime-a',
    )).rejects.toThrow('runtime changed');
    expect(boundTransportRequests.filter(({ url }) => url.includes('/prompt_async'))).toHaveLength(1);

    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
    switchDuringPreflight = false;
    switchDuringPromptDispatch = true;
    await sendReviewFeedbackToOriginal(review.id, '/canonical/review', 'fix this', 'runtime-a');
    expect(boundTransportRequests.filter(({ url }) => url.includes('/prompt_async')).map(({ url }) => url)).toEqual([
      'http://runtime-a.test/api/session/original-preflight/prompt_async?directory=%2Fcanonical%2Foriginal',
      'http://runtime-a.test/api/session/original-preflight/prompt_async?directory=%2Fcanonical%2Foriginal',
    ]);
    expect(boundTransportReleaseCount).toBe(3);
  });
  test('gets and sends implementation responses in the review session authoritative directory', async () => {
    const { getCalls } = installReviewTransactionClient({
      existingBackend: 'pi',
      originalDirectory: '/canonical/original',
      oldReviewDirectory: '/canonical/review',
    });

    await sendImplementationResponseToReviewer(
      'original-transaction',
      '/canonical/original',
      'implemented',
      true,
      'runtime-a',
    );

    expect(getCalls).toEqual([
      { sessionID: 'original-transaction', directory: '/canonical/original' },
      { sessionID: 'review-old', directory: '/canonical/review' },
    ]);
    expect(optimisticSendCalls.map(({ sessionId, directory }) => ({ sessionId, directory }))).toEqual([
      { sessionId: 'review-old', directory: '/canonical/review' },
    ]);
  });

  test('keeps the bound review operation until the implementation response is dispatched', async () => {
    const transaction = installReviewTransactionClient({ existingBackend: 'pi' });
    let releasedDuringSend: boolean | null = null;
    optimisticSendImpl = async (input) => {
      releasedDuringSend = transaction.isReleased();
      optimisticSendCalls.push(input);
      input.onMessageID?.('message-sent');
    };

    await sendImplementationResponseToReviewer(
      'original-transaction',
      '/workspace',
      'implemented',
      true,
      'runtime-a',
    );

    expect(releasedDuringSend).toBe(false);
    expect(transaction.isReleased()).toBe(true);
  });

  test('does not probe the original current directory when the linked review directory is unavailable', async () => {
    const { getCalls } = installReviewTransactionClient({
      existingBackend: 'pi',
      originalDirectory: '/canonical/original',
      oldReviewDirectory: '/canonical/review',
      indexOldReview: false,
    });

    await expect(sendImplementationResponseToReviewer(
      'original-transaction',
      '/canonical/original',
      'implemented',
      true,
      'runtime-a',
    )).rejects.toThrow('Review session directory is unavailable');

    expect(getCalls).toEqual([
      { sessionID: 'original-transaction', directory: '/canonical/original' },
    ]);
    expect(optimisticSendCalls).toEqual([]);
  });
});
