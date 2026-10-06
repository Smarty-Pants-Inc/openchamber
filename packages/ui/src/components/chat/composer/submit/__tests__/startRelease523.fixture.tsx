import React, { act } from 'react';
import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import { NATIVE_CREATION_INVALIDATED, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { directory, session, deferred, type nativeDraftFixture } from '@/sync/native-draft-fixture';
import { useNativeDraftStarting, resetNativeDraftPage } from '@/sync/native-draft-start';
import { resetSentStartsForPage } from '@/sync/native-draft-sent';
import { abandonedNativeCreations } from '@/sync/native-draft-control';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { mountedNativeComposer } from './nativeComposer.fixture';

export const directoryB = '/native-project-b';
const requestBody = z.object({ clientRequestId: z.uuid() });
const replyBody = z.object({ action: z.enum(['trust', 'ready', 'cancel', 'deny']) });
const endpoint = '52352352-3523-4523-8523-523523523524';
const generation = '52352352-3523-4523-8523-523523523525';
const stopped = (operation: NativeCreationState): NativeCreationState => ({ ...operation, generation: null, revision: 0, phase: 'cancelled' });
type Held = { operation: NativeCreationState; response: ReturnType<typeof deferred<Response>>; released: boolean };
function server523(fixture: ReturnType<typeof nativeDraftFixture>, mode: 'create' | 'trust', expiryMs: number) {
  const operations = new Map<string, NativeCreationState>(), held: Held[] = [];
  const state = { listReads: 0, actions: new Array<string>(), abandons: new Array<string>(), refuse: false, holdMore: false };
  const entered = deferred<void>();
  let abandonResponse: ((cancelled: NativeCreationState) => Response | Promise<Response>) | undefined;
  const hold = (operation: NativeCreationState) => {
    const gate = { operation: { ...operation }, response: deferred<Response>(), released: false };
    held.push(gate); entered.resolve(); return gate.response.promise;
  };
  const operation = () => {
    const found = operations.get(directory);
    if (!found) throw new Error('Expected actual A create request');
    return found;
  };
  fixture.handlers.health = async () => Response.json({ healthy: true,
    capabilities: { ordinaryInteractiveCreate: 1, creationClientRequestId: 1, creationAbandon: 1 } });
  fixture.handlers.create = async request => {
    const body = requestBody.parse(await request.json()), target = new URL(request.url).searchParams.get('directory');
    if (!target) throw new Error('Create missing directory');
    const first = held.length === 0;
    const next: NativeCreationState = { operationId: crypto.randomUUID(), directory: target, generation: endpoint, revision: 1,
      phase: mode === 'trust' ? 'awaiting-trust' : 'starting', expiresAt: Date.now() + expiryMs,
      canInitialReady: false, clientRequestId: body.clientRequestId };
    operations.set(target, next);
    if (mode === 'create' && first || state.holdMore) return hold(next);
    if (mode === 'trust' && first) return Response.json({ nativeCreation: next }, { status: 202 });
    operations.set(target, { ...next, phase: 'ready' });
    return Response.json({ ...session, id: crypto.randomUUID(), directory: target,
      nativeCreation: { ...session.nativeCreation, inputReady: true } });
  };
  const inner = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url), path = url.pathname;
    if (!path.includes('/session/creation')) return inner(input, init);
    if (url.hostname !== 'synthetic.invalid') throw new Error('Unexpected creation network target');
    fixture.requests.push(request.clone());
    const target = url.searchParams.get('directory') ?? '', next = operations.get(target);
    if (path.endsWith('/creation')) { state.listReads++; return Response.json({ nativeCreations: next ? [next] : [] }); }
    if (!next) throw new Error('Operation request before create');
    if (!path.includes(next.operationId)) throw new Error('Wrong operation requested');
    if (path.endsWith('/abandon')) {
      state.abandons.push(next.operationId);
      if (state.refuse) return Response.json({ name: 'APIError', data: { message: 'This start already finished; nothing to abandon', isRetryable: false } }, { status: 409 });
      const cancelled = stopped(next); operations.set(target, cancelled);
      return abandonResponse ? abandonResponse(cancelled) : Response.json({ nativeCreation: cancelled });
    }
    if (path.endsWith('/reply')) {
      const { action } = replyBody.parse(await request.json()); state.actions.push(action);
      if (action === 'trust' && held.length === 0) return hold(next);
      return Response.json({ nativeCreation: next });
    }
    return Response.json({ nativeCreation: next });
  }, inner);
  const release = (index = 0, phase: 'cancelled' | 'ready' = 'cancelled') => {
    const gate = held[index]; if (!gate || gate.released) return;
    gate.released = true;
    const next = phase === 'cancelled' ? stopped(gate.operation) : { ...gate.operation, phase,
      native: { id: session.id, generation }, canInitialReady: false };
    gate.response.resolve(Response.json({ nativeCreation: next }, { status: mode === 'create' || index > 0 ? 202 : 200 }));
  };
  return { state, operation, entered: entered.promise, held, release,
    respondToStop: (response: (cancelled: NativeCreationState) => Response | Promise<Response>) => { abandonResponse = response; },
    restore: () => { globalThis.fetch = inner; } };
}

export async function mountedStart523(mode: 'create' | 'trust', expiryMs = 600_000) {
  function Starting() { return <output data-testid="start-reservation">{String(useNativeDraftStarting())}</output>; }
  let server: ReturnType<typeof server523> | undefined;
  const composer = await mountedNativeComposer(true, undefined, <Starting />, undefined, fixture => {
    server = server523(fixture, mode, expiryMs);
  });
  if (!server) throw new Error('Cold start setup missing');
  const own = server;
  return { ...composer, server: own,
    starting: () => composer.dom.container.querySelector('[data-testid="start-reservation"]')?.textContent === 'true',
    stop: () => composer.dom.container.querySelector<HTMLButtonElement>(`button[data-operation-id="${own.operation().operationId}"]`),
    refresh: () => act(async () => {
      window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED, { detail: { runtimeKey: composer.runtimeA, directory } }));
      composer.rerender(); await sleep(10);
    }),
    navigate: (project: 'a' | 'b') => act(async () => {
      const target = project === 'a' ? directory : directoryB;
      // A successful B Send closes the draft. Return through the real New session action, not a picker on a closed draft.
      if (!useSessionUIStore.getState().newSessionDraft.open) {
        useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: project, directoryOverride: target });
      } else composer.target(project, target);
      await sleep(10);
    }),
    clickStop: () => act(async () => {
      const button = composer.dom.container.querySelector<HTMLButtonElement>(`button[data-operation-id="${own.operation().operationId}"]`);
      if (!button) throw new Error('Actual NativeCreationNotice Stop missing');
      button.click(); await sleep(20);
    }),
    dispose: async () => {
      await act(async () => { own.held.forEach((_, index) => own.release(index)); await sleep(20); });
      own.restore(); resetNativeDraftPage(); resetSentStartsForPage(); abandonedNativeCreations.clear();
      await composer.dispose();
    },
  };
}
