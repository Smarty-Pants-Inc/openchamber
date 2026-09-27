import React from 'react';
import { afterAll, expect, mock, test } from 'bun:test';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { NativeCreationError, nativeCreationFailure, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import type { useNativeCreation } from '../state/useNativeCreation';

// smarty-code#523 (3.38, account 1): a start that never settles blocked New session in its project with no control.
// The notice offers "Stop this start" (the gateway's abandon): at once past its expiry, else after a grace; a refusal says
// why and changes nothing else.
const i18n = await import('@/lib/i18n');
// SAFETY: every key the notice asks for is a string entry of the English creation messages.
mock.module('@/lib/i18n', () => ({ ...i18n, useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en) => nativeCreationI18n.en[key] ?? key }) }));
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
const start = await import('@/sync/native-draft-start');
mock.module('@/sync/native-draft-start', () => ({ ...start, useNativeDraftStarting: () => false, useUnresolvedNativeStart: () => false }));
const { opencodeClient } = await import('@/lib/opencode/client');
const { NativeCreationNotice } = await import('./NativeCreationNotice');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { STOP_START_GRACE_MS, abandonedNativeCreations } = await import('@/sync/native-draft-control');
const { Window } = await import('happy-dom');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');

const STOP = nativeCreationI18n.en['chat.nativeCreation.stopStart'];
const blocking = (id: string, expiresIn: number): NativeCreationState => ({ operationId: id, directory: '/project', generation: 'g',
  revision: 2, phase: 'unavailable', expiresAt: Date.now() + expiresIn, canInitialReady: false, clientRequestId: `req-${id}` });
const native = (operations: NativeCreationState[], refreshed: string[]): ReturnType<typeof useNativeCreation> => ({
  mode: 'ordinary', session: null, creation: null, canAbandon: true, operations, refusal: null,
  refresh: async () => { refreshed.push('refresh'); }, cancel: async () => {},
  describeError: error => nativeCreationFailure(error).detail ?? nativeCreationI18n.en[`chat.nativeCreation.${(error as NativeCreationError).code}` as keyof typeof nativeCreationI18n.en],
  beforeSend: async () => undefined, noteRefusal: () => new NativeCreationError('unavailable') });

const names = ['window', 'document', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
const host = document.createElement('div'), root = createRoot(host);
useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, open: true, directoryOverride: '/project' } }));
afterAll(async () => {
  await act(async () => root.unmount());
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});
const show = (value: ReturnType<typeof useNativeCreation>) => act(async () => root.render(<NativeCreationNotice native={value} draftOpen />));
const stopButton = () => [...host.querySelectorAll('button')].find(button => button.textContent === STOP);

test('a blocking start past its expiry can be stopped at once; stopping it frees the project', async () => {
  const calls: string[] = [], refreshed: string[] = [];
  const original = opencodeClient.abandonNativeCreation;
  opencodeClient.abandonNativeCreation = (async (directory: string, id: string) => {
    calls.push(`${directory} ${id}`); return { ...blocking(id, -1), phase: 'cancelled' };
  }) as typeof original;
  try {
    const op = blocking('op-expired', -60_000); // The 3.38 orphan: 'unavailable', past its expiry.
    await show(native([op], refreshed));
    expect(host.textContent).toContain(nativeCreationI18n.en['chat.nativeCreation.elsewhere']);
    await act(async () => { stopButton()!.click(); await new Promise(done => setTimeout(done, 10)); });
    expect(calls).toEqual(['/project op-expired']);
    expect(abandonedNativeCreations.has('op-expired')).toBe(true);
    expect(refreshed).toEqual(['refresh']);
    await show(native([op], refreshed)); // A list read before the stop still has it: it no longer blocks.
    expect(host.textContent).not.toContain(nativeCreationI18n.en['chat.nativeCreation.elsewhere']);
  } finally { opencodeClient.abandonNativeCreation = original; }
});

test('a start within its time is not offered for stopping until the grace passes', async () => {
  const now = Date.now, at = now();
  let clock = at;
  Date.now = () => clock;
  try {
    const op = blocking('op-young', 10 * 60_000);
    await show(native([op], []));
    expect(host.textContent).toContain(nativeCreationI18n.en['chat.nativeCreation.elsewhere']);
    expect(stopButton()).toBeUndefined();
    clock = at + STOP_START_GRACE_MS + 1;
    await show(native([op], []));
    expect(stopButton()).toBeDefined();
  } finally { Date.now = now; }
});

test('a stop the gateway refuses says why, keeps the draft text, and the start still blocks', async () => {
  const original = opencodeClient.abandonNativeCreation;
  opencodeClient.abandonNativeCreation = (async () => {
    throw nativeCreationFailure({ name: 'APIError', data: { message: 'This start already finished; nothing to abandon', isRetryable: false } }, 409);
  }) as typeof original;
  try {
    const op = blocking('op-refused', -1);
    useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, initialPrompt: 'Keep this' } }));
    await show(native([op], []));
    await act(async () => { stopButton()!.click(); await new Promise(done => setTimeout(done, 10)); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('This start already finished; nothing to abandon');
    expect(abandonedNativeCreations.has('op-refused')).toBe(false);
    expect(useSessionUIStore.getState().newSessionDraft.initialPrompt).toBe('Keep this');
    expect(host.textContent).toContain(nativeCreationI18n.en['chat.nativeCreation.elsewhere']);
    expect(stopButton()).toBeDefined(); // It can be tried again.
  } finally { opencodeClient.abandonNativeCreation = original; }
});

test('without the gateway\'s abandon the notice offers no stop', async () => {
  await show({ ...native([blocking('op-noabandon', -1)], []), canAbandon: false });
  expect(stopButton()).toBeUndefined();
});

test('text locked as sent to a start that never settles comes back when that start is stopped', async () => {
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { createChatDraftIdentity, claimChatDraftOwnership, writeChatDraft, readChatDraft } = await import('@/lib/chatDraftPersistence');
  const op = blocking('op-sent', -1);
  const markKey = `oc.nativeCreation.sent:${JSON.stringify([getRuntimeKey(), '/project'])}`;
  const draftId = useSessionUIStore.getState().newSessionDraft.draftId;
  const identity = createChatDraftIdentity(getRuntimeKey(), '/project', null, draftId)!;
  claimChatDraftOwnership(identity); writeChatDraft(identity, 'Locked text', []);
  localStorage.setItem(markKey, JSON.stringify({ clientRequestId: op.clientRequestId, operationId: op.operationId }));
  const originals = { abandon: opencodeClient.abandonNativeCreation, list: opencodeClient.listNativeCreations };
  opencodeClient.abandonNativeCreation = (async () => ({ ...op, phase: 'cancelled' })) as typeof originals.abandon;
  opencodeClient.listNativeCreations = (async () => [{ ...op, phase: 'cancelled' }]) as typeof originals.list;
  try {
    await act(async () => root.render(<NativeCreationNotice native={native([op], [])} draftOpen sent="unknown" />));
    expect(host.textContent).toContain(nativeCreationI18n.en['chat.nativeCreation.sentPending']);
    await act(async () => { stopButton()!.click(); await new Promise(done => setTimeout(done, 20)); });
    expect(localStorage.getItem(markKey)).toBeNull(); // No longer locked as sent...
    expect(readChatDraft(identity).text).toBe('Locked text'); // ...and the text is back as the draft.
  } finally {
    opencodeClient.abandonNativeCreation = originals.abandon; opencodeClient.listNativeCreations = originals.list;
    localStorage.clear();
  }
});
