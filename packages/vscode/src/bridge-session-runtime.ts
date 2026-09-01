import { isDeepStrictEqual } from 'node:util';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import {
  SessionBackendPolicyError,
  assertForkSourceSession,
  authorizeManagedBackendStamp,
  assertSessionForkSourceBackend,
  authorizeSessionForkTarget,
  assertSessionSendBackend,
  foldSessionBackendHistory,
  resolveSessionForkSource,
  resolveSessionSend,
  withAgentBackendMetadata,
} from '../../web/server/lib/openchamber-sessions/session-backend-policy.js';
import type { BridgeContext } from './bridge';
import { waitForApiUrl } from './opencode-ready';
import { isRecord } from './bridge-runtime-shapes';

export type SessionProxyResponse = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

type SessionRecord = {
  id: string;
  directory?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

type SessionMessageRecord = {
  info?: {
    id?: string;
    providerID?: string;
    model?: { providerID?: string };
  };
};

type SdkResult<T> = {
  data?: T;
  error?: unknown;
  response?: { status?: number; headers?: Headers };
};

type SessionRequestOptions = { signal?: AbortSignal };

type SessionClient = {
  session: {
    get: (input: { sessionID: string; directory: string }, options?: SessionRequestOptions) => Promise<SdkResult<SessionRecord>>;
    update: (input: { sessionID: string; directory: string; metadata: Record<string, unknown> }, options?: SessionRequestOptions) => Promise<SdkResult<SessionRecord>>;
    messages: (input: { sessionID: string; directory: string; limit: number; before?: string }, options?: SessionRequestOptions) => Promise<SdkResult<SessionMessageRecord[]>>;
    fork: (input: { sessionID: string; directory: string; messageID?: string }, options?: SessionRequestOptions) => Promise<SdkResult<SessionRecord>>;
    delete: (input: { sessionID: string; directory: string }, options?: SessionRequestOptions) => Promise<SdkResult<boolean>>;
  };
};

export type SessionRuntimeDeps = {
  waitForApiUrl: (manager?: BridgeContext['manager']) => Promise<string | null>;
  createClient: (apiUrl: string, authHeaders?: Record<string, string>) => SessionClient;
};

const defaultDeps: SessionRuntimeDeps = {
  waitForApiUrl,
  createClient: (apiUrl, authHeaders) => createOpencodeClient({
    baseUrl: apiUrl.replace(/\/+$/, ''),
    headers: authHeaders || {},
  }) as unknown as SessionClient,
};

type ForkCleanupResult = { confirmed: boolean; detail: string };

type ForkRetainedDetails = {
  partial: true;
  partialAction: 'fork-retained';
  sessionId: string;
  directory?: string;
  recovery: { fork: ForkCleanupResult };
};

class SessionRouteError extends Error {
  readonly status: number;
  readonly details?: ForkRetainedDetails;

  constructor(message: string, status = 500, details?: ForkRetainedDetails) {
    super(message);
    this.name = 'SessionRouteError';
    this.status = status;
    this.details = details;
  }
}

// Shared policy failures map identically in Web and VS Code. SDK result errors
// remain a VS Code transport concern and keep their upstream status or 502.
export const sessionBackendPolicyStatus = (error: Error): number | null => {
  if (!(error instanceof SessionBackendPolicyError)) return null;
  return error.category === 'conflict' ? 409 : 502;
};

const sessionRouteStatus = (error: Error): number | null => (
  sessionBackendPolicyStatus(error)
  ?? (error instanceof SessionRouteError ? error.status : null)
);

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new SessionRouteError('Request cancelled', 499);
};

const requestOptions = (signal?: AbortSignal): SessionRequestOptions | undefined => signal ? { signal } : undefined;

type MetadataOperation = {
  type: 'set' | 'delete';
  key: string;
  expected: { exists: boolean; value?: unknown };
  value?: unknown;
};

const mutationLocks = new Map<string, Promise<void>>();

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const jsonResponse = (status: number, body: unknown): SessionProxyResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  bodyText: JSON.stringify(body),
});

const errorResponse = (error: unknown): SessionProxyResponse => {
  const failure = error instanceof Error ? error : null;
  const status = failure ? sessionRouteStatus(failure) ?? 500 : 500;
  const message = failure?.message || 'Failed to handle OpenChamber session request';
  const details = failure instanceof SessionRouteError ? failure.details : undefined;
  return jsonResponse(status, { error: message, ...(details ?? {}) });
};

const withSessionLock = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
  const previous = mutationLocks.get(key) || Promise.resolve();
  let release: (() => void) | undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationLocks.set(key, next);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (mutationLocks.get(key) === next) mutationLocks.delete(key);
  }
};

const metadataRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

const openChamberRecord = (metadata: unknown): Record<string, unknown> => {
  const namespace = metadataRecord(metadata).openchamber;
  return isRecord(namespace) ? namespace : {};
};

const requireSession = (result: SdkResult<SessionRecord>, operation: string): SessionRecord => {
  if (result.data && typeof result.data.id === 'string' && result.data.id.length > 0) return result.data;
  const status = result.response?.status;
  const detail = result.error instanceof Error ? `: ${result.error.message}` : '';
  throw new SessionRouteError(`${operation} failed${detail}`, status || 502);
};
const requireAuthoritativeSessionDirectory = (session: SessionRecord, operation: string): string => {
  const directory = typeof session.directory === 'string' ? session.directory.trim() : '';
  if (!directory) {
    throw new SessionRouteError(`${operation} did not return an authoritative session directory`, 502);
  }
  return directory;
};


const readSession = async (
  client: SessionClient,
  sessionId: string,
  directory: string,
  operation: string,
  signal?: AbortSignal,
): Promise<SessionRecord> => {
  throwIfAborted(signal);
  const result = await client.session.get({ sessionID: sessionId, directory }, requestOptions(signal));
  throwIfAborted(signal);
  return requireSession(result, operation);
};

const changedOpenChamberKeys = (before: Record<string, unknown>, after: Record<string, unknown>): string[] => {
  const previous = openChamberRecord(before);
  const next = openChamberRecord(after);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter((key) => !isDeepStrictEqual(previous[key], next[key]));
};

const hasAppliedKeys = (session: SessionRecord, metadata: Record<string, unknown>, keys: string[]): boolean => {
  const current = openChamberRecord(session.metadata);
  const expected = openChamberRecord(metadata);
  return keys.every((key) => isDeepStrictEqual(current[key], expected[key]));
};

const mutateMetadata = async <T>(
  client: SessionClient,
  sessionId: string,
  directory: string,
  mutate: (metadata: Record<string, unknown>, session: SessionRecord) => { metadata: Record<string, unknown>; result: T },
  signal?: AbortSignal,
): Promise<{ session: SessionRecord; result: T }> => {
  const current = await readSession(client, sessionId, directory, 'read session metadata', signal);
  const metadata = metadataRecord(current.metadata);
  const mutation = mutate(metadata, current);
  const changedKeys = changedOpenChamberKeys(metadata, mutation.metadata);
  if (changedKeys.length === 0) return { session: current, result: mutation.result };

  throwIfAborted(signal);
  try {
    return {
      session: requireSession(
        // Session update has no idempotency key. Once dispatched, let it settle
        // and recover its exact outcome instead of aborting an uncertain write.
        await client.session.update({ sessionID: sessionId, directory, metadata: mutation.metadata }),
        'update session metadata',
      ),
      result: mutation.result,
    };
  } catch (error) {
    try {
      const recovered = await readSession(client, sessionId, directory, 'recover session metadata update');
      if (hasAppliedKeys(recovered, mutation.metadata, changedKeys)) {
        return { session: recovered, result: mutation.result };
      }
    } catch {
      // Preserve the original uncertain write error when recovery cannot prove it.
    }
    throw error;
  }
};

const parseMetadataOperations = (value: unknown): MetadataOperation[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SessionRouteError('At least one session metadata operation is required', 400);
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)
      || (candidate.type !== 'set' && candidate.type !== 'delete')
      || !Array.isArray(candidate.path)
      || candidate.path.length !== 2
      || candidate.path[0] !== 'openchamber'
      || typeof candidate.path[1] !== 'string'
      || !/^[A-Za-z0-9_]+$/.test(candidate.path[1])
      || !isRecord(candidate.expected)
      || typeof candidate.expected.exists !== 'boolean') {
      throw new SessionRouteError('Invalid session metadata operation', 400);
    }
    if (candidate.expected.exists && !hasOwn(candidate.expected, 'value')) {
      throw new SessionRouteError('Invalid session metadata operation', 400);
    }
    if (candidate.type === 'set' && !hasOwn(candidate, 'value')) {
      throw new SessionRouteError('Invalid session metadata operation', 400);
    }
    return {
      type: candidate.type,
      key: candidate.path[1],
      expected: candidate.expected.exists
        ? { exists: true, value: candidate.expected.value }
        : { exists: false },
      ...(candidate.type === 'set' ? { value: candidate.value } : {}),
    };
  });
};

const applyMetadataOperations = (metadata: Record<string, unknown>, operations: MetadataOperation[]): Record<string, unknown> => {
  const currentNamespace = openChamberRecord(metadata);
  for (const operation of operations) {
    const exists = hasOwn(currentNamespace, operation.key);
    if (exists !== operation.expected.exists
      || (exists && !isDeepStrictEqual(currentNamespace[operation.key], operation.expected.value))) {
      throw new SessionRouteError('Session metadata changed before the update could be applied', 409);
    }
  }
  const nextNamespace = { ...currentNamespace };
  for (const operation of operations) {
    if (operation.type === 'delete') delete nextNamespace[operation.key];
    else nextNamespace[operation.key] = operation.value;
  }
  return { ...metadata, openchamber: nextNamespace };
};

type ManagedBackend = 'pi' | 'omp' | 'codex';

const readSessionBackendHistory = (
  client: SessionClient,
  sessionId: string,
  directory: string,
  signal?: AbortSignal,
) => foldSessionBackendHistory(async (before) => {
  throwIfAborted(signal);
  const response = await client.session.messages(
    { sessionID: sessionId, directory, limit: 100, before },
    requestOptions(signal),
  );
  throwIfAborted(signal);
  if (response.error) {
    throw new SessionRouteError('Failed to read source session history', response.response?.status || 502);
  }
  return {
    records: response.data,
    nextCursor: response.response?.headers?.get('x-next-cursor') ?? null,
  };
});

const persistManagedBackend = async (
  client: SessionClient,
  sessionId: string,
  directory: string,
  providerId: ManagedBackend,
  signal?: AbortSignal,
): Promise<{ session: SessionRecord; backend: ManagedBackend }> => {
  const mutation = await mutateMetadata(client, sessionId, directory, (metadata, session) => {
    const decision = authorizeManagedBackendStamp({ session, providerID: providerId });
    return {
      metadata: decision.backfillBackend
        ? withAgentBackendMetadata(metadata, decision.backfillBackend)
        : metadata,
      result: { backend: providerId },
    };
  }, signal);
  return { session: mutation.session, backend: mutation.result.backend };
};
const authorizeInteractiveSend = async (
  client: SessionClient,
  sessionId: string,
  directory: string,
  providerId: string,
  signal?: AbortSignal,
): Promise<SessionRecord> => {
  const historyBackendClass = await readSessionBackendHistory(client, sessionId, directory, signal);
  const mutation = await mutateMetadata(client, sessionId, directory, (metadata, session) => {
    const decision = resolveSessionSend({ session, historyBackendClass });
    return {
      metadata: decision.backfillBackend
        ? withAgentBackendMetadata(metadata, decision.backfillBackend)
        : metadata,
      result: decision,
    };
  }, signal);
  assertSessionSendBackend({ backend: mutation.result.backend, providerID: providerId });
  return mutation.session;
};


type ForkSource = { backend: 'omp' | null };

const authorizeForkSource = async (
  client: SessionClient,
  sessionId: string,
  directory: string,
  signal?: AbortSignal,
): Promise<ForkSource> => {
  const source = await readSession(client, sessionId, directory, 'read source session backend metadata', signal);
  assertForkSourceSession(source);

  const historyBackendClass = await readSessionBackendHistory(client, sessionId, directory, signal);
  const mutation = await mutateMetadata(client, sessionId, directory, (metadata, current) => {
    const decision = resolveSessionForkSource({ session: current, historyBackendClass });
    return {
      metadata: decision.backfillBackend
        ? withAgentBackendMetadata(metadata, decision.backfillBackend)
        : metadata,
      result: decision,
    };
  }, signal);
  assertSessionForkSourceBackend(mutation.result.backend);
  throwIfAborted(signal);
  return { backend: mutation.result.backend === 'omp' ? 'omp' : null };
};



const stampForkedSessionBackend = async (
  client: SessionClient,
  session: SessionRecord,
  directory: string,
  sourceBackend: 'omp' | null,
  signal?: AbortSignal,
): Promise<SessionRecord> => {
  if (!sourceBackend) return { ...session, directory };
  const mutation = await persistManagedBackend(client, session.id, directory, sourceBackend, signal);
  return { ...session, ...mutation.session, directory };
};

const cleanupRequestOptions = (): SessionRequestOptions | undefined => (
  typeof AbortSignal.timeout === 'function'
    ? { signal: AbortSignal.timeout(5_000) }
    : undefined
);

const confirmSessionRemoved = async (
  client: SessionClient,
  sessionId: string,
  directory: string,
): Promise<ForkCleanupResult> => {
  let deleteError = '';
  try {
    const response = await client.session.delete(
      { sessionID: sessionId, directory },
      cleanupRequestOptions(),
    );
    if (response.data !== true && response.response?.status !== 404) {
      deleteError = 'OpenCode did not confirm deletion of the forked session';
    }
  } catch (error) {
    deleteError = error instanceof Error ? error.message : String(error);
  }

  try {
    const response = await client.session.get(
      { sessionID: sessionId, directory },
      cleanupRequestOptions(),
    );
    if (response.data?.id) {
      return { confirmed: false, detail: deleteError || 'The forked session still exists' };
    }
    if (response.response?.status === 404) return { confirmed: true, detail: '' };
    return {
      confirmed: false,
      detail: deleteError || 'Could not confirm that the forked session was removed',
    };
  } catch (error) {
    const response = isRecord(error) && isRecord(error.response) ? error.response : null;
    const status = response?.status ?? (isRecord(error) ? error.status : undefined);
    if (status === 404 || status === '404') return { confirmed: true, detail: '' };
    const detail = error instanceof Error ? error.message : String(error);
    return { confirmed: false, detail: deleteError ? `${deleteError}; ${detail}` : detail };
  }
};

const forkRetainedError = (
  error: unknown,
  sessionId: string,
  directory: string | null,
  cleanup: ForkCleanupResult,
): SessionRouteError => {
  const failure = error instanceof Error ? error : new Error('Failed to fork session');
  return new SessionRouteError(
    failure.message,
    sessionRouteStatus(failure) ?? 500,
    {
      partial: true,
      partialAction: 'fork-retained',
      sessionId,
      ...(directory ? { directory } : {}),
      recovery: { fork: cleanup },
    },
  );
};

const parseRequestBody = (bodyBase64: string | undefined): Record<string, unknown> => {
  if (!bodyBase64) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bodyBase64, 'base64').toString('utf8'));
    if (!isRecord(parsed)) throw new Error('body is not an object');
    return parsed;
  } catch {
    throw new SessionRouteError('Invalid JSON request body', 400);
  }
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SessionRouteError(`${field} is required`, 400);
  }
  return value.trim();
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new SessionRouteError(`${field} must be a string`, 400);
  return value.trim() || undefined;
};

const routeMatch = (requestPath: string): {
  sessionId: string;
  action: 'metadata' | 'send-preflight' | 'fork-capability' | 'fork-authorized';
} | null => {
  let parsed: URL;
  try {
    parsed = new URL(requestPath, 'https://openchamber.local');
  } catch {
    return null;
  }
  const match = parsed.pathname.match(
    /^\/(?:api\/)?openchamber\/sessions\/([^/]+)\/(metadata|send-preflight|fork-capability|fork-authorized)$/,
  );
  if (!match) return null;
  try {
    const sessionId = decodeURIComponent(match[1]).trim();
    if (!sessionId) return null;
    return {
      sessionId,
      action: match[2] as 'metadata' | 'send-preflight' | 'fork-capability' | 'fork-authorized',
    };
  } catch {
    throw new SessionRouteError('Invalid session id', 400);
  }
};

/**
 * Handles session-specific OpenChamber routes before the generic bridge proxy.
 * These APIs belong to OpenChamber, not OpenCode, and therefore use explicit
 * SDK calls and policy checks in the extension host.
 */
export const tryHandleOpenChamberSessionProxy = async (
  method: string,
  requestPath: string,
  bodyBase64: string | undefined,
  ctx: BridgeContext | undefined,
  signal?: AbortSignal,
  deps: SessionRuntimeDeps = defaultDeps,
): Promise<SessionProxyResponse | null> => {
  let route;
  try {
    route = routeMatch(requestPath);
  } catch (error) {
    return errorResponse(error);
  }
  if (!route) return null;

  const expectedMethod = route.action === 'metadata' ? 'PATCH' : 'POST';
  if (method !== expectedMethod) {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    throwIfAborted(signal);
    const body = parseRequestBody(bodyBase64);
    const directory = requiredString(body.directory, 'directory');
    const apiUrl = await deps.waitForApiUrl(ctx?.manager);
    throwIfAborted(signal);
    if (!apiUrl) return jsonResponse(503, { error: 'OpenCode API unavailable' });
    const client = deps.createClient(apiUrl, ctx?.manager?.getOpenCodeAuthHeaders());
    const lockKey = `${directory}\u0000${route.sessionId}`;

    if (route.action === 'metadata') {
      const operations = parseMetadataOperations(body.operations);
      const mutation = await withSessionLock(lockKey, () => mutateMetadata(
        client,
        route.sessionId,
        directory,
        (metadata) => ({
          metadata: applyMetadataOperations(metadata, operations),
          result: undefined,
        }),
        signal,
      ));
      return jsonResponse(200, { session: mutation.session });
    }

    if (route.action === 'send-preflight') {
      const providerId = requiredString(body.providerID, 'providerID');
      await withSessionLock(
        lockKey,
        () => authorizeInteractiveSend(client, route.sessionId, directory, providerId, signal),
      );
      return jsonResponse(200, { authorized: true });
    }

    if (route.action === 'fork-capability') {
      try {
        await withSessionLock(
          lockKey,
          () => authorizeForkSource(client, route.sessionId, directory, signal),
        );
        return jsonResponse(200, { supported: true });
      } catch (error) {
        if (error instanceof Error && sessionRouteStatus(error) === 409) {
          return jsonResponse(200, { supported: false });
        }
        throw error;
      }
    }

    const messageId = optionalString(body.messageId, 'messageId');
    const providerId = optionalString(body.providerID, 'providerID');
    let forkDirectory: string | null = null;
    const forked = await withSessionLock(lockKey, async () => {
      const source = await authorizeForkSource(client, route.sessionId, directory, signal);
      authorizeSessionForkTarget({ sourceBackend: source.backend, targetProviderID: providerId });
      throwIfAborted(signal);

      let session: SessionRecord | null = null;
      try {
        // Fork is non-idempotent. Do not attach the caller signal after
        // dispatch; an aborted caller still gets exact-child compensation.
        const created = requireSession(
          await client.session.fork({ sessionID: route.sessionId, directory, messageID: messageId }),
          'fork session',
        );
        session = created;
        const childDirectory = requireAuthoritativeSessionDirectory(created, 'Fork session');
        forkDirectory = childDirectory;
        throwIfAborted(signal);
        const stamped = await withSessionLock(
          `${childDirectory}\u0000${created.id}`,
          () => stampForkedSessionBackend(client, created, childDirectory, source.backend, signal),
        );
        throwIfAborted(signal);
        return stamped;
      } catch (error) {
        if (!session?.id) throw error;
        const cleanup = forkDirectory
          ? await confirmSessionRemoved(client, session.id, forkDirectory)
          : { confirmed: false, detail: 'forked session did not return an authoritative directory' };
        if (cleanup.confirmed) throw error;
        throw forkRetainedError(error, session.id, forkDirectory, cleanup);
      }
    });
    return jsonResponse(200, { session: forked, directory: forkDirectory });
  } catch (error) {
    return errorResponse(error);
  }
};
