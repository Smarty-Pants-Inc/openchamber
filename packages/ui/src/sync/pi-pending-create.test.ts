import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import type { PiSessionCreateOperation } from './pi-pending-create';

type CreatedSession = {
  id: string;
  directory?: string | null;
};
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };


type FetchCall = {
  input: string;
  init?: RuntimeFetchOptions;
};

let runtimeKey = 'runtime-a';
let requestImpl: (input: string, init?: RuntimeFetchOptions) => Promise<Response>;
const runtimeChangeListeners: Array<() => void> = [];
const fetchCalls: FetchCall[] = [];
const getCalls: Array<{ sessionID: string; directory: string }> = [];
const deleteCalls: Array<{ sessionID: string; directory: string }> = [];
let getImpl: (sessionID: string, directory: string) => Promise<CreatedSession>;
let deleteImpl: (sessionID: string, directory: string) => Promise<boolean>;

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const jsonResponse = (payload: JsonValue, status = 200): Response => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const recordRequest = (input: string | URL | Request, init?: RuntimeFetchOptions): Promise<Response> => {
  const path = input.toString();
  fetchCalls.push({ input: path, init });
  return requestImpl(path, init);
};

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: recordRequest }));
const correlationQuerySchema = z.object({ correlation: z.string().min(1) });

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => '',
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointWillChange: (listener: () => void) => {
    runtimeChangeListeners.push(listener);
    return () => {
      const index = runtimeChangeListeners.indexOf(listener);
      if (index !== -1) runtimeChangeListeners.splice(index, 1);
    };
  },
}));

// Runtime dependencies above must be mocked before this transport module loads.
const {
  createPiSessionWithPendingDialogs,
  PiSessionCreateRetainedError,
  replyToPendingPiCreateDialog,
  usePiPendingCreateStore,
} = await import('./pi-pending-create');

const createOperation = (onAssertCurrent?: () => void): PiSessionCreateOperation<CreatedSession> => {
  const capturedRuntimeKey = runtimeKey;
  return {
    runtimeKey: capturedRuntimeKey,
    request: recordRequest,
    get: async (sessionID, directory) => {
      getCalls.push({ sessionID, directory });
      return getImpl(sessionID, directory);
    },
    delete: async (sessionID, directory) => {
      deleteCalls.push({ sessionID, directory });
      return deleteImpl(sessionID, directory);
    },
    assertCurrent: () => {
      onAssertCurrent?.();
      if (runtimeKey !== capturedRuntimeKey) throw new Error('runtime changed');
    },
  };
};

const waitForPiFetch = async (input: string): Promise<void> => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (fetchCalls.some((call) => call.input === input)) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${input}`);
};

const waitForPendingDialog = async (dialogID: string): Promise<void> => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const pending = Object.values(usePiPendingCreateStore.getState().pendingCreates)[0];
    if (pending?.dialogs.some((dialog) => dialog.id === dialogID)) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for pending dialog ${dialogID}`);
};

const waitForPendingCreatesToClear = async (): Promise<void> => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (Object.keys(usePiPendingCreateStore.getState().pendingCreates).length === 0) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for pending creates to clear');
};

beforeEach(() => {
  runtimeKey = 'runtime-a';
  runtimeChangeListeners.length = 0;
  fetchCalls.length = 0;
  getCalls.length = 0;
  deleteCalls.length = 0;
  usePiPendingCreateStore.setState({ pendingCreates: {} });
  requestImpl = async () => jsonResponse([]);
  getImpl = async (sessionID, directory) => ({ id: sessionID, directory });
  deleteImpl = async () => true;
});

describe('Pi pending create dialogs', () => {
  test('selects the exact gateway array record and accepts a titleless confirm', async () => {
    const createResponse = deferred<Response>();
    requestImpl = async (input, init) => {
      if (input === '/api/pending-create') {
        const { correlation } = correlationQuerySchema.parse(init?.query);
        return jsonResponse([
          {
            pendingCreateID: 'pending-other-directory',
            directory: '/workspace/other',
            correlation,
            dialogs: [{ type: 'extension_ui_request', id: 'wrong-1', method: 'confirm', message: 'Wrong' }],
          },
          {
            pendingCreateID: 'pending-other-correlation',
            directory: '/workspace/pi',
            correlation: 'another-create',
            dialogs: [{ type: 'extension_ui_request', id: 'wrong-2', method: 'confirm', message: 'Wrong' }],
          },
          {
            pendingCreateID: 'pending-1',
            directory: '/workspace/pi',
            correlation,
            dialogs: [
              { type: 'extension_ui_request', id: 'note-1', method: 'notify', title: 'ignore' },
              {
                type: 'extension_ui_request',
                id: 'fresh-startup-confirm',
                method: 'confirm',
                message: 'Continue?',
              },
            ],
          },
        ]);
      }
      if (input === '/api/session') return createResponse.promise;
      return new Response(null, { status: 204 });
    };

    const created = createPiSessionWithPendingDialogs(
      { directory: '/workspace/pi', title: 'Pi session' },
      createOperation(),
    );
    await waitForPiFetch('/api/pending-create');
    await waitForPendingDialog('fresh-startup-confirm');

    const [pending] = Object.values(usePiPendingCreateStore.getState().pendingCreates);
    expect(pending?.pendingCreateID).toBe('pending-1');
    expect(pending?.dialogs).toHaveLength(1);
    expect(pending?.dialogs[0]?.title).toBe('Continue?');
    const correlation = pending?.correlation ?? '';

    await replyToPendingPiCreateDialog(correlation, 'fresh-startup-confirm', { confirmed: true });

    const poll = fetchCalls.find((call) => call.input === '/api/pending-create');
    const reply = fetchCalls.find((call) => call.input === '/api/pending-create/pending-1/dialog/fresh-startup-confirm');
    expect(poll?.init?.query).toEqual({ directory: '/workspace/pi', correlation });
    expect(reply?.init?.query).toEqual({ directory: '/workspace/pi', correlation });
    expect(reply?.init?.body).toBe(JSON.stringify({ confirmed: true }));

    createResponse.resolve(jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' }));
    expect(await created).toEqual({ id: 'ses-pi', directory: '/canonical/pi' });
    expect(getCalls).toEqual([{ sessionID: 'ses-pi', directory: '/canonical/pi' }]);
    expect(usePiPendingCreateStore.getState().pendingCreates).toEqual({});
  });

  test('returns the create response directory when the loaded session omits it', async () => {
    requestImpl = async (input) => input === '/api/session'
      ? jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' })
      : jsonResponse([]);
    getImpl = async (sessionID) => ({ id: sessionID });

    const created = await createPiSessionWithPendingDialogs(
      { directory: '/requested/pi' },
      createOperation(),
    );

    expect(created).toEqual({ id: 'ses-pi', directory: '/canonical/pi' });
    expect(getCalls).toEqual([{ sessionID: 'ses-pi', directory: '/canonical/pi' }]);
  });

  test('keeps the create active when polling sees a 404 before any pending record', async () => {
    const createResponse = deferred<Response>();
    requestImpl = async (input) => {
      if (input === '/api/pending-create') return new Response(null, { status: 404 });
      if (input === '/api/session') return createResponse.promise;
      return new Response(null, { status: 204 });
    };

    const created = createPiSessionWithPendingDialogs({ directory: '/workspace/pi' }, createOperation());
    await waitForPiFetch('/api/pending-create');
    expect(Object.keys(usePiPendingCreateStore.getState().pendingCreates)).toHaveLength(1);

    createResponse.resolve(jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' }));
    expect(await created).toEqual({ id: 'ses-pi', directory: '/canonical/pi' });
  });

  test('clears an observed lane when a valid snapshot no longer has its correlation', async () => {
    const createResponse = deferred<Response>();
    const secondPollStarted = deferred<void>();
    let correlation = '';
    let pollCount = 0;
    requestImpl = async (input, init) => {
      if (input === '/api/session') {
        correlation = correlationQuerySchema.parse(init?.query).correlation;
        return createResponse.promise;
      }
      if (input === '/api/pending-create') {
        pollCount += 1;
        if (pollCount === 1) {
          return jsonResponse([{
            pendingCreateID: 'pending-observed',
            directory: '/workspace/pi',
            correlation,
            dialogs: [{ type: 'extension_ui_request', id: 'confirm-observed', method: 'confirm', message: 'Continue?' }],
          }]);
        }
        secondPollStarted.resolve();
        return jsonResponse([]);
      }
      return new Response(null, { status: 204 });
    };

    const created = createPiSessionWithPendingDialogs({ directory: '/workspace/pi' }, createOperation());
    await waitForPendingDialog('confirm-observed');
    await secondPollStarted.promise;
    await waitForPendingCreatesToClear();

    expect(pollCount).toBe(2);
    createResponse.resolve(jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' }));
    expect(await created).toEqual({ id: 'ses-pi', directory: '/canonical/pi' });
  });

  test('stops the poll lane before loading a successful create response', async () => {
    const createResponse = deferred<Response>();
    const pendingPollResponse = deferred<Response>();
    const loaded = deferred<CreatedSession>();
    let pollSignal: AbortSignal | undefined;
    const loadStarted = deferred<void>();
    requestImpl = async (input, init) => {
      if (input === '/api/pending-create') {
        pollSignal = init?.signal ?? undefined;
        pollSignal?.addEventListener('abort', () => {
          pendingPollResponse.resolve(new Response(null, { status: 499 }));
        }, { once: true });
        return pendingPollResponse.promise;
      }
      if (input === '/api/session') return createResponse.promise;
      return new Response(null, { status: 204 });
    };
    getImpl = async () => {
      loadStarted.resolve();
      return loaded.promise;
    };

    const created = createPiSessionWithPendingDialogs({ directory: '/workspace/pi' }, createOperation());
    await waitForPiFetch('/api/pending-create');
    createResponse.resolve(jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' }));
    await loadStarted.promise;
    expect(pollSignal?.aborted).toBe(true);
    expect(usePiPendingCreateStore.getState().pendingCreates).toEqual({});

    loaded.resolve({ id: 'ses-pi', directory: '/canonical/pi' });
    expect(await created).toEqual({ id: 'ses-pi', directory: '/canonical/pi' });
  });

  test('compensates an exact created session when the runtime switches during the poll drain', async () => {
    const pendingPollResponse = deferred<Response>();
    const loaded = deferred<CreatedSession>();
    const loadStarted = deferred<void>();
    const postLoadAuthorityCheck = deferred<void>();
    let assertions = 0;
    let pollSignal: AbortSignal | undefined;
    requestImpl = async (input, init) => {
      if (input === '/api/pending-create') {
        pollSignal = init?.signal ?? undefined;
        return pendingPollResponse.promise;
      }
      if (input === '/api/session') return jsonResponse({ id: 'ses-pi', directory: '/canonical/created' });
      return new Response(null, { status: 204 });
    };
    getImpl = async () => {
      loadStarted.resolve();
      return loaded.promise;
    };

    const created = createPiSessionWithPendingDialogs({ directory: '/workspace/pi' }, createOperation(() => {
      assertions += 1;
      if (assertions === 3) postLoadAuthorityCheck.resolve();
    }));
    await waitForPiFetch('/api/pending-create');
    await loadStarted.promise;
    expect(pollSignal?.aborted).toBe(true);

    loaded.resolve({ id: 'ses-pi', directory: '/canonical/loaded' });
    await postLoadAuthorityCheck.promise;
    expect(assertions).toBe(3);

    runtimeKey = 'runtime-b';
    pendingPollResponse.resolve(jsonResponse([]));

    await expect(created).rejects.toThrow('runtime changed');
    expect(assertions).toBe(4);
    expect(deleteCalls).toEqual([{ sessionID: 'ses-pi', directory: '/canonical/loaded' }]);
  });

  test('compensates a load failure in the directory returned by the gateway', async () => {
    const loadFailure = new Error('session load failed');
    requestImpl = async (input) => input === '/api/session'
      ? jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' })
      : jsonResponse([]);
    getImpl = async () => { throw loadFailure; };

    await expect(createPiSessionWithPendingDialogs(
      { directory: '/requested/pi' },
      createOperation(),
    )).rejects.toThrow('session load failed');
    expect(deleteCalls).toEqual([{ sessionID: 'ses-pi', directory: '/canonical/pi' }]);
  });

  test('uses the loaded authoritative directory when a runtime changes after loading', async () => {
    requestImpl = async (input) => input === '/api/session'
      ? jsonResponse({ id: 'ses-pi', directory: '/canonical/created' })
      : jsonResponse([]);
    getImpl = async () => {
      runtimeKey = 'runtime-b';
      return { id: 'ses-pi', directory: '/canonical/loaded' };
    };

    await expect(createPiSessionWithPendingDialogs(
      { directory: '/requested/pi' },
      createOperation(),
    )).rejects.toThrow('runtime changed');
    expect(deleteCalls).toEqual([{ sessionID: 'ses-pi', directory: '/canonical/loaded' }]);
  });

  test('returns typed retained recovery when exact deletion throws', async () => {
    requestImpl = async (input) => input === '/api/session'
      ? jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' })
      : jsonResponse([]);
    getImpl = async () => { throw new Error('session load failed'); };
    deleteImpl = async () => { throw new Error('delete failed'); };

    let error: unknown;
    try {
      await createPiSessionWithPendingDialogs({ directory: '/requested/pi' }, createOperation());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PiSessionCreateRetainedError);
    if (!(error instanceof PiSessionCreateRetainedError)) throw error;
    expect(error.recovery.status).toBe('retained');
    expect(error.recovery.sessionID).toBe('ses-pi');
    expect(error.recovery.directory).toBe('/canonical/pi');
    expect(error.recovery.runtimeKey).toBe('runtime-a');
    expect(error.recovery.cause.message).toBe('session load failed');
    expect(error.recovery.compensationError.message).toBe('delete failed');
  });

  test('returns typed retained recovery when deletion is not confirmed', async () => {
    requestImpl = async (input) => input === '/api/session'
      ? jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' })
      : jsonResponse([]);
    getImpl = async () => { throw new Error('session load failed'); };
    deleteImpl = async () => false;

    let error: unknown;
    try {
      await createPiSessionWithPendingDialogs({ directory: '/requested/pi' }, createOperation());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PiSessionCreateRetainedError);
    if (!(error instanceof PiSessionCreateRetainedError)) throw error;
    expect(error.recovery.directory).toBe('/canonical/pi');
    expect(error.recovery.compensationError.message).toBe('Failed to confirm removal of the created Pi session');
  });

  test('retains typed recovery instead of guessing when the gateway omits the directory', async () => {
    requestImpl = async (input) => input === '/api/session'
      ? jsonResponse({ id: 'ses-pi' })
      : jsonResponse([]);

    let error: unknown;
    try {
      await createPiSessionWithPendingDialogs({ directory: '/requested/pi' }, createOperation());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PiSessionCreateRetainedError);
    if (!(error instanceof PiSessionCreateRetainedError)) throw error;
    expect(error.recovery.directory).toBeNull();
    expect(deleteCalls).toEqual([]);
  });

  test('discovers and awaits old-runtime dialog cancellation after a runtime switch', async () => {
    const createResponse = deferred<Response>();
    const pendingPollResponse = deferred<Response>();
    const pendingPollPayload = deferred<JsonValue>();
    const pendingPollJsonRequested = deferred<boolean>();
    const cancellationResponse = deferred<Response>();
    let pollSignal: AbortSignal | undefined;
    let correlation = '';
    requestImpl = async (input, init) => {
      if (input === '/api/session') {
        correlation = correlationQuerySchema.parse(init?.query).correlation;
        return createResponse.promise;
      }
      if (input === '/api/pending-create') {
        pollSignal = init?.signal ?? undefined;
        return pendingPollResponse.promise;
      }
      if (input === '/api/pending-create/pending-runtime-switch/dialog/confirm-runtime-switch') {
        return cancellationResponse.promise;
      }
      return jsonResponse([]);
    };

    const created = createPiSessionWithPendingDialogs({ directory: '/requested/pi' }, createOperation());
    await waitForPiFetch('/api/pending-create');

    runtimeKey = 'runtime-b';
    runtimeChangeListeners.forEach((listener) => listener());

    expect(pollSignal?.aborted).toBe(false);
    expect(usePiPendingCreateStore.getState().pendingCreates).toEqual({});

    const pendingResponse = new Response(null, { status: 200 });
    pendingResponse.json = async () => {
      pendingPollJsonRequested.resolve(true);
      return pendingPollPayload.promise;
    };
    pendingPollResponse.resolve(pendingResponse);
    await pendingPollJsonRequested.promise;

    let settled = false;
    void created.then(() => { settled = true; }, () => { settled = true; });
    createResponse.resolve(jsonResponse({ id: 'ses-pi', directory: '/canonical/pi' }));
    for (let attempt = 0; attempt < 32 && deleteCalls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(pollSignal?.aborted).toBe(true);
    expect(deleteCalls).toEqual([{ sessionID: 'ses-pi', directory: '/canonical/pi' }]);
    expect(settled).toBe(false);

    pendingPollPayload.resolve([{
      pendingCreateID: 'pending-runtime-switch',
      directory: '/requested/pi',
      correlation,
      dialogs: [
        { type: 'extension_ui_request', id: 'confirm-runtime-switch', method: 'confirm', message: 'Continue?', timeout: 300_000 },
      ],
    }]);
    await waitForPiFetch('/api/pending-create/pending-runtime-switch/dialog/confirm-runtime-switch');

    const cancellation = fetchCalls.find((call) => (
      call.input === '/api/pending-create/pending-runtime-switch/dialog/confirm-runtime-switch'
    ));
    expect(cancellation?.init?.query).toEqual({ directory: '/requested/pi', correlation });
    expect(cancellation?.init?.body).toBe(JSON.stringify({ cancelled: true }));
    expect(settled).toBe(false);

    cancellationResponse.resolve(jsonResponse({ accepted: true }));
    await expect(created).rejects.toThrow('runtime changed');
    expect(usePiPendingCreateStore.getState().pendingCreates).toEqual({});
  });

});
