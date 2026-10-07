import React, { act } from 'react';
import { expect, spyOn } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer, shownActivity } from './nativeComposer.fixture';
import { acceptedView, deferred, directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { usePromptsInFlight } from '@/sync/prompts-in-flight';
import { useNotificationStore } from '@/sync/notification-store';
import { opencodeClient } from '@/lib/opencode/client';
import { sendUnconfirmed } from '@/lib/sendUnconfirmed';
import { z } from 'zod';

// Load after the existing widget/platform isolation, not before its Vite-worker boundary.
const sync = await import('@/sync/sync-context');
const { ChatInput } = await import('@/components/chat/ChatInput');
const { SessionErrorNotice } = await import('@/components/chat/SessionErrorNotice');
// Remove the inherited fixture's idle-only override. Both notice selectors run their real subscriptions.
spyOn(sync, 'useSessionStatus').mockRestore();

type ContextHost = typeof globalThis & {
  __openchamber_sync_runtime_context__?: React.Context<ReturnType<typeof sync.useSyncRuntime> | null>;
};
// SAFETY: sync-context initializes this exact global with its React context before these dynamic imports return.
// Its inferred runtime type keeps the fixture provider identical without adding a product export or replacing hooks.
const RuntimeContext = (globalThis as ContextHost).__openchamber_sync_runtime_context__;
if (!RuntimeContext) throw new Error('Production sync runtime context was not initialized');
const RuntimeProvider = RuntimeContext.Provider;

export const words = 'receipt race original';
export const conflict = () => Response.json({ name: 'APIError', data: {
  message: 'Client message ID already exists or a submission is pending', isRetryable: false,
} }, { status: 409 });
export const admitted = (receipt: 'queued' | 'accepted') => new Response(null, { status: 204,
  headers: { 'x-smarty-prompt-receipt': receipt } });
export const pause = (ms: number) => act(async () => { await sleep(ms); });
export const flight = () => usePromptsInFlight.getState();
export const pending = () => flight().pending[session.id] ?? 0;

export async function receiptRace902() {
  expect(sendUnconfirmed.ms).toBe(45_000); // Never shorten the production watchdog.
  const initialFlight = flight(), initialNotifications = useNotificationStore.getState();
  usePromptsInFlight.setState({ pending: {}, answeredAt: {}, receipt: {} });
  useNotificationStore.setState({ list: [] });
  const c = await mountedNativeComposer(false, undefined, undefined, fixture => (
    <RuntimeProvider value={{ childStores: fixture.children, messageLoader: fixture.loader,
      runtimeKey: fixture.runtimeA, sdk: opencodeClient.getSdkClient(),
      currentDirectory: { get: () => directory, subscribe: () => () => undefined } }}>
      <ChatInput />
      <section data-testid="receipt-notice"><SessionErrorNotice sessionId={session.id} directory={directory} /></section>
    </RuntimeProvider>
  ), fixture => {
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: directory,
      newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
    const ordinary = { ...session, title: 'org', ordinary: { generation: 'g1', sequence: 1,
      thinkingLevel: 'high', model: { providerID: 'p', modelID: 'm', name: 'Model' } } };
    fixture.children.ensureChild(directory, { bootstrap: false }).setState({ session: [ordinary],
      session_status: { [session.id]: { type: 'busy', ordinary: true,
        ordinaryTarget: { generation: 'g1', presentationId: 'run-1' } } } });
    shownActivity.phase = 'busy';
  });
  await c.loader.ensure({ directory, sessionID: session.id });
  expect(c.loader.getAcceptedOrdinaryView({ directory, sessionID: session.id }, c.runtimeA)).toBe(acceptedView);
  const answers = [deferred<Response>(), deferred<Response>()];
  let calls = 0;
  c.handlers.prompt = async () => {
    const answer = answers[calls++];
    if (!answer) throw new Error('Unexpected third prompt POST');
    return answer.promise;
  };
  const routing = sync.createEventRoutingIndex();
  const promptBody = z.object({ messageID: z.string().min(1) });
  const child = c.children.getChild(directory);
  if (!child) throw new Error('Actual fixture child store missing');
  const event = (payload: Parameters<typeof sync.handleEvent>[1]) => act(async () => {
    sync.handleEvent(directory, payload, c.children, routing, c.runtimeA);
    await sleep(20);
  });
  await c.replace(words);
  return { ...c, child, event,
    idle: () => event({ id: crypto.randomUUID(), type: 'session.idle', properties: { sessionID: session.id } }),
    notice: () => c.dom.container.querySelector('[data-testid="receipt-notice"]')?.textContent ?? '',
    rows: () => child.getState().message[session.id] ?? [],
    failures: () => useNotificationStore.getState().list.filter(n => n.type === 'error').filter(n => n.session === session.id),
    ids: async () => Promise.all(c.prompts().map(async request => promptBody.parse(await request.clone().json()).messageID)),
    answer: (index: number, response: Response) => act(async () => { answers[index].resolve(response); await sleep(50); }),
    dispose: async () => {
      await act(async () => { for (const answer of answers) answer.resolve(new Response(null, { status: 204 })); await sleep(50); });
      await c.dispose(); shownActivity.phase = 'idle';
      usePromptsInFlight.setState(initialFlight, true); useNotificationStore.setState(initialNotifications, true);
    },
  };
}
