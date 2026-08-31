import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { RetainedSessionError, type RetainedSessionRecovery } from '@/lib/retainedSessionError';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';

const PI_CREATE_POLL_INTERVAL_MS = 250;

const piCreateDialogInputSchema = z.discriminatedUnion('method', [
  z.object({
    type: z.literal('extension_ui_request'),
    id: z.string().min(1),
    method: z.literal('select'),
    title: z.string(),
    options: z.array(z.string()),
    timeout: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('extension_ui_request'),
    id: z.string().min(1),
    method: z.literal('confirm'),
    title: z.string().optional(),
    message: z.string(),
    timeout: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('extension_ui_request'),
    id: z.string().min(1),
    method: z.literal('input'),
    title: z.string(),
    placeholder: z.string().optional(),
    timeout: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('extension_ui_request'),
    id: z.string().min(1),
    method: z.literal('editor'),
    title: z.string(),
    prefill: z.string().optional(),
    timeout: z.number().nonnegative().optional(),
  }),
]);

const piCreateDialogSchema = piCreateDialogInputSchema.transform((dialog) => (
  dialog.method === 'confirm'
    ? { ...dialog, title: dialog.title?.trim() || dialog.message }
    : dialog
));

const pendingCreateEnvelopeSchema = z.object({
  pendingCreateID: z.string().min(1),
  directory: z.string().min(1),
  correlation: z.string().min(1),
  dialogs: z.array(z.json()),
});
const pendingCreateListSchema = z.array(pendingCreateEnvelopeSchema);

const createdSessionSchema = z.object({
  id: z.string().min(1),
  directory: z.string().min(1),
});
const createdSessionIDSchema = z.object({ id: z.string().min(1) });
const terminalReplySchema = z.object({ retryable: z.literal(false) });

export type PiCreateDialog = z.infer<typeof piCreateDialogSchema>;
export type PendingPiCreateDialog = PiCreateDialog & { observedAt: number };

export type PendingPiCreate = {
  /** Stable local identity before the gateway assigns its pending create ID. */
  pendingCreateID: string;
  serverPendingCreateID: string | null;
  runtimeKey: string;
  directory: string;
  correlation: string;
  dialogs: PendingPiCreateDialog[];
  resolvedDialogIDs: string[];
  replyingDialogIDs: string[];
};

type PiPendingCreateStore = {
  pendingCreates: Record<string, PendingPiCreate>;
};

export const usePiPendingCreateStore = create<PiPendingCreateStore>()(() => ({
  pendingCreates: {},
}));

const localPendingCreateID = (correlation: string): string => `pending:${correlation}`;

const clearPendingPiCreate = (correlation: string): void => {
  usePiPendingCreateStore.setState((state) => {
    if (!(correlation in state.pendingCreates)) return state;
    const { [correlation]: _removed, ...pendingCreates } = state.pendingCreates;
    void _removed;
    return { pendingCreates };
  });
};

const registerPendingPiCreate = (input: {
  runtimeKey: string;
  directory: string;
  correlation: string;
}): void => {
  usePiPendingCreateStore.setState((state) => ({
    pendingCreates: {
      ...state.pendingCreates,
      [input.correlation]: {
        pendingCreateID: localPendingCreateID(input.correlation),
        serverPendingCreateID: null,
        runtimeKey: input.runtimeKey,
        directory: input.directory,
        correlation: input.correlation,
        dialogs: [],
        resolvedDialogIDs: [],
        replyingDialogIDs: [],
      },
    },
  }));
};

const publishPendingPiCreate = (input: {
  pendingCreateID: string;
  runtimeKey: string;
  directory: string;
  correlation: string;
  dialogs: PiCreateDialog[];
}): void => {
  usePiPendingCreateStore.setState((state) => {
    const current = state.pendingCreates[input.correlation];
    if (
      !current
      || current.runtimeKey !== input.runtimeKey
      || current.directory !== input.directory
      || current.correlation !== input.correlation
    ) {
      return state;
    }

    const observedAtByID = new Map(current.dialogs.map((dialog) => [dialog.id, dialog.observedAt]));
    const dialogs = input.dialogs
      .filter((dialog) => !current.resolvedDialogIDs.includes(dialog.id))
      .map((dialog) => ({
        ...dialog,
        observedAt: observedAtByID.get(dialog.id) ?? Date.now(),
      }));

    return {
      pendingCreates: {
        ...state.pendingCreates,
        [input.correlation]: {
          ...current,
          pendingCreateID: input.pendingCreateID,
          serverPendingCreateID: input.pendingCreateID,
          dialogs,
        },
      },
    };
  });
};

const reservePendingPiCreateDialogReply = (correlation: string, requestID: string): PendingPiCreate | null => {
  let reserved: PendingPiCreate | null = null;
  usePiPendingCreateStore.setState((state) => {
    const current = state.pendingCreates[correlation];
    if (
      !current
      || !current.serverPendingCreateID
      || !current.dialogs.some((dialog) => dialog.id === requestID)
      || current.replyingDialogIDs.includes(requestID)
    ) {
      return state;
    }

    reserved = current;
    return {
      pendingCreates: {
        ...state.pendingCreates,
        [correlation]: {
          ...current,
          replyingDialogIDs: [...current.replyingDialogIDs, requestID],
        },
      },
    };
  });
  return reserved;
};

const finishPendingPiCreateDialogReply = (
  correlation: string,
  requestID: string,
  resolved: boolean,
): void => {
  usePiPendingCreateStore.setState((state) => {
    const current = state.pendingCreates[correlation];
    if (!current) return state;

    const replyingDialogIDs = current.replyingDialogIDs.filter((id) => id !== requestID);
    const resolvedDialogIDs = resolved && !current.resolvedDialogIDs.includes(requestID)
      ? [...current.resolvedDialogIDs, requestID]
      : current.resolvedDialogIDs;
    const dialogs = resolved ? current.dialogs.filter((dialog) => dialog.id !== requestID) : current.dialogs;

    return {
      pendingCreates: {
        ...state.pendingCreates,
        [correlation]: {
          ...current,
          replyingDialogIDs,
          resolvedDialogIDs,
          dialogs,
        },
      },
    };
  });
};

const readResponseDetail = async (response: Response): Promise<string> => {
  const text = await response.clone().text().catch(() => '');
  return text.trim();
};

const createResponseError = async (response: Response, operation: string): Promise<Error> => {
  const detail = await readResponseDetail(response);
  return new Error(`${operation} failed (${response.status})${detail ? `: ${detail}` : ''}`);
};

const isTerminalReplyFailure = async (response: Response): Promise<boolean> => {
  if (response.status === 400 || response.status === 404) return true;
  const payload = await response.clone().json().catch(() => null);
  return terminalReplySchema.safeParse(payload).success;
};

const errorSchema = z.instanceof(Error);

export type RetainedPiSessionCreate = RetainedSessionRecovery;

export class PiSessionCreateRetainedError extends RetainedSessionError {
  declare readonly recovery: RetainedPiSessionCreate;

  constructor(
    sessionID: string,
    directory: string | null,
    runtimeKey: string,
    cause: Error,
    compensationError: Error,
  ) {
    super(`Pi session ${sessionID} was created but could not be removed: ${compensationError.message}`, {
      sessionID,
      directory,
      runtimeKey,
      cause,
      compensationError,
    });
    this.name = 'PiSessionCreateRetainedError';
  }
}

export type PiCreateDialogReply =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true; timedOut?: true };

/**
 * Sends one reply only to the pending create that supplied the dialog. A scope
 * mismatch is terminal: the gateway has already resolved or discarded it, so
 * remove the card instead of letting it leak into another create attempt.
 */
export const replyToPendingPiCreateDialog = async (
  correlation: string,
  requestID: string,
  reply: PiCreateDialogReply,
): Promise<void> => {
  const pending = reservePendingPiCreateDialogReply(correlation, requestID);
  if (!pending?.serverPendingCreateID) return;

  try {
    if (getRuntimeKey() !== pending.runtimeKey) {
      throw new Error('Pi session creation stopped because the runtime changed');
    }

    const response = await runtimeFetch(
      `/api/pending-create/${encodeURIComponent(pending.serverPendingCreateID)}/dialog/${encodeURIComponent(requestID)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        query: { directory: pending.directory, correlation: pending.correlation },
        body: JSON.stringify(reply),
      },
    );
    if (!response.ok) {
      if (await isTerminalReplyFailure(response)) {
        finishPendingPiCreateDialogReply(correlation, requestID, true);
        return;
      }
      throw await createResponseError(response, 'pending Pi dialog reply');
    }

    finishPendingPiCreateDialogReply(correlation, requestID, true);
  } catch (error) {
    finishPendingPiCreateDialogReply(correlation, requestID, false);
    throw error;
  }
};

const createCorrelation = (): string => {
  const cryptoAPI = globalThis.crypto;
  if (cryptoAPI?.randomUUID) return cryptoAPI.randomUUID();
  if (cryptoAPI?.getRandomValues) {
    const bytes = cryptoAPI.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('Secure random generation is unavailable for Pi session creation');
};

type PendingCreateListInput = z.input<typeof pendingCreateListSchema>;

const parsePendingPiCreate = (
  payload: PendingCreateListInput,
  directory: string,
  correlation: string,
): {
  pendingCreateID: string;
  directory: string;
  correlation: string;
  dialogs: PiCreateDialog[];
} | null => {
  const pendingCreates = pendingCreateListSchema.safeParse(payload);
  if (!pendingCreates.success) return null;
  const envelope = pendingCreates.data.find((candidate) => (
    candidate.directory === directory && candidate.correlation === correlation
  ));
  if (!envelope) return null;
  return {
    pendingCreateID: envelope.pendingCreateID,
    directory: envelope.directory,
    correlation: envelope.correlation,
    dialogs: envelope.dialogs.flatMap((dialog) => {
      const parsed = piCreateDialogSchema.safeParse(dialog);
      return parsed.success ? [parsed.data] : [];
    }),
  };
};

export type PiSessionCreateInput = {
  directory: string;
  parentID?: string;
  title?: string;
  metadata?: SessionMetadataRecord;
};

export type PiCreateTransportRequest = (
  input: string | URL | Request,
  init?: RuntimeFetchOptions,
) => Promise<Response>;

export type PiSessionCreateOperation<T extends { directory?: string | null }> = {
  runtimeKey: string;
  request: PiCreateTransportRequest;
  get: (sessionID: string, directory: string) => Promise<T>;
  delete: (sessionID: string, directory: string) => Promise<boolean>;
  assertCurrent: () => void;
};

type PiCreatePollTimeoutID = Parameters<typeof clearTimeout>[0];

const waitForNextPiCreatePoll = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutID);
    signal.removeEventListener('abort', finish);
    resolve();
  };
  const timeoutID: PiCreatePollTimeoutID = setTimeout(finish, PI_CREATE_POLL_INTERVAL_MS);
  signal.addEventListener('abort', finish, { once: true });
  if (signal.aborted) finish();
});


const compensateKnownPiSession = async <T extends { directory?: string | null }>(
  operation: PiSessionCreateOperation<T>,
  sessionID: string,
  directory: string,
  cause: Error,
): Promise<never> => {
  try {
    const deleted = await operation.delete(sessionID, directory);
    if (!deleted) throw new Error('Failed to confirm removal of the created Pi session');
  } catch (error) {
    const parsedError = errorSchema.safeParse(error);
    throw new PiSessionCreateRetainedError(
      sessionID,
      directory,
      operation.runtimeKey,
      cause,
      parsedError.success ? parsedError.data : new Error('Failed to remove the created Pi session'),
    );
  }
  throw cause;
};

/**
 * Starts the Pi create request and consumes its startup dialogs in parallel.
 * Every request uses the transport captured by the owning session operation.
 */
export const createPiSessionWithPendingDialogs = async <T extends { directory?: string | null }>(
  input: PiSessionCreateInput,
  operation: PiSessionCreateOperation<T>,
): Promise<T> => {
  operation.assertCurrent();
  const runtimeKey = operation.runtimeKey;
  const correlation = createCorrelation();
  const pollController = new AbortController();
  let pollActive = true;
  let observedPendingRecord = false;
  let runtimeChanged = false;

  const stopPolling = (): void => {
    if (!pollActive) return;
    pollActive = false;
    pollController.abort();
    clearPendingPiCreate(correlation);
  };
  const isRuntimeCurrent = (): boolean => {
    if (runtimeChanged) return false;
    try {
      operation.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };

  registerPendingPiCreate({ runtimeKey, directory: input.directory, correlation });
  const unsubscribeRuntimeChange = subscribeRuntimeEndpointWillChange(() => {
    runtimeChanged = true;
    // The POST may already have reached Pi. Stop only the dialog lane, then
    // wait for its response so a returned session ID can be compensated.
    stopPolling();
  });

  const poll = async (): Promise<void> => {
    while (pollActive) {
      try {
        const response = await operation.request('/api/pending-create', {
          query: { directory: input.directory, correlation },
          signal: pollController.signal,
        });
        if (!pollActive) break;
        if (!isRuntimeCurrent()) {
          stopPolling();
          break;
        }
        if (!response.ok) {
          if (response.status === 400 || (response.status === 404 && observedPendingRecord)) {
            // A pending dialog lane can end independently of the POST. Never
            // reject or abort the non-idempotent create from this observer.
            stopPolling();
            break;
          }
        } else {
          const pending = parsePendingPiCreate(await response.json(), input.directory, correlation);
          if (pending && isRuntimeCurrent()) {
            observedPendingRecord = true;
            publishPendingPiCreate({ ...pending, runtimeKey });
          }
        }
      } catch (error) {
        if (!pollActive || pollController.signal.aborted) break;
        // Poll transport failures are retryable while the create POST is still
        // pending. Keep existing cards visible rather than erasing context.
        void error;
      }

      if (pollActive) await waitForNextPiCreatePoll(pollController.signal);
    }
  };

  const createRequest = operation.request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    query: { directory: input.directory, correlation },
    body: JSON.stringify({
      parentID: input.parentID,
      title: input.title,
      metadata: input.metadata,
    }),
  });
  void poll();

  try {
    const response = await createRequest;
    if (!response.ok) throw await createResponseError(response, 'session.create');

    // Once POST succeeds, the gateway may remove its pending record before the
    // follow-up session load finishes. Stop polling before that load begins.
    stopPolling();
    const payload: unknown = await response.json();
    const created = createdSessionSchema.safeParse(payload);
    if (!created.success) {
      const identified = createdSessionIDSchema.safeParse(payload);
      if (identified.success) {
        const cause = new Error('session.create failed: response omitted its authoritative directory');
        throw new PiSessionCreateRetainedError(
          identified.data.id,
          null,
          runtimeKey,
          cause,
          new Error('Exact cleanup target is unknown because the created session directory was not returned'),
        );
      }
      throw new Error('session.create failed: malformed response');
    }

    if (!isRuntimeCurrent()) {
      return await compensateKnownPiSession(
        operation,
        created.data.id,
        created.data.directory,
        new Error('Pi session creation stopped because the runtime changed'),
      );
    }

    let session: T;
    try {
      session = await operation.get(created.data.id, created.data.directory);
    } catch (error) {
      const parsedError = errorSchema.safeParse(error);
      return await compensateKnownPiSession(
        operation,
        created.data.id,
        created.data.directory,
        parsedError.success ? parsedError.data : new Error('Failed to load the created Pi session'),
      );
    }

    const authoritativeDirectory = session.directory?.trim() || created.data.directory;
    const normalizedSession = session.directory === authoritativeDirectory
      ? session
      : { ...session, directory: authoritativeDirectory };
    if (!isRuntimeCurrent()) {
      return await compensateKnownPiSession(
        operation,
        created.data.id,
        authoritativeDirectory,
        new Error('Pi session creation stopped because the runtime changed'),
      );
    }
    return normalizedSession;
  } finally {
    unsubscribeRuntimeChange();
    stopPolling();
  }
};
