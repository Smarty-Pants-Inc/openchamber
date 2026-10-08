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
mock.module('@/lib/i18n', () => ({ ...i18n, useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en, params: Record<string, string> = {}) =>
  (nativeCreationI18n.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name) }) }));
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
  // SAFETY: the refusal passed here is always a NativeCreationError, and its code names an i18n key.
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
const stopButton = () => [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith(STOP));

test('a blocking start past its expiry can be stopped at once; stopping it frees the project', async () => {
  const calls: string[] = [], refreshed: string[] = [];
  const original = opencodeClient.abandonNativeCreation;
  // SAFETY: a test double with the client method's own call shape.
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
  // SAFETY: a test double with the client method's own call shape.
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
  // SAFETY: a test double with the client method's own call shape.
  opencodeClient.abandonNativeCreation = (async () => ({ ...op, phase: 'cancelled' })) as typeof originals.abandon;
  // SAFETY: a test double with the client method's own call shape.
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

test('after a Send the blocking start refused, the notice still offers to stop it', async () => {
  const calls: string[] = [];
  const original = opencodeClient.abandonNativeCreation;
  // SAFETY: a test double with the client method's own call shape.
  opencodeClient.abandonNativeCreation = (async (_: string, id: string) => { calls.push(id); return { ...blocking(id, -1), phase: 'cancelled' }; }) as typeof original;
  try {
    const op = blocking('op-after-send', -1);
    await show({ ...native([op], []), refusal: new NativeCreationError('elsewhere') }); // Send was refused: 'elsewhere'.
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(nativeCreationI18n.en['chat.nativeCreation.elsewhere']);
    await act(async () => { stopButton()!.click(); await new Promise(done => setTimeout(done, 10)); });
    expect(calls).toEqual(['op-after-send']);
  } finally { opencodeClient.abandonNativeCreation = original; }
});

// Review of #298: the control is bound to the start it stops, and stays bound to the one it shows. smarty-code#1491: its
// visible label is plain ("Stop the stuck start"); the start's id is kept in its title and data attribute, not shown.
test('the stop is bound to its start, and when the blocking start changes it binds to and stops the new one', async () => {
  const calls: string[] = [];
  const original = opencodeClient.abandonNativeCreation;
  // SAFETY: a test double with the client method's own call shape.
  opencodeClient.abandonNativeCreation = (async (_: string, id: string) => { calls.push(id); return { ...blocking(id, -1), phase: 'cancelled' }; }) as typeof original;
  try {
    const first = blocking('1111aaaa-first', -1), second = blocking('2222bbbb-second', -1);
    await show(native([first], []));
    expect(stopButton()!.textContent).toBe(STOP);
    expect(stopButton()!.getAttribute('title')).toBe(first.operationId);
    expect(stopButton()!.getAttribute('data-operation-id')).toBe(first.operationId);
    await show(native([second], [])); // The first settled elsewhere; another start now blocks.
    expect(stopButton()!.textContent).toBe(STOP);
    expect(stopButton()!.getAttribute('data-operation-id')).toBe(second.operationId);
    await act(async () => { stopButton()!.click(); await new Promise(done => setTimeout(done, 10)); });
    expect(calls).toEqual([second.operationId]); // Never the stale one.
  } finally { opencodeClient.abandonNativeCreation = original; }
});

test('text back after a start someone stopped says who stopped it', async () => {
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const op = { ...blocking('3333cccc-stopped', -1), phase: 'cancelled' as const, stoppedBy: { issuer: 'https://code.example', subject: 'kate-1', name: 'Kate' } };
  const markKey = `oc.nativeCreation.sent:${JSON.stringify([getRuntimeKey(), '/project'])}`;
  localStorage.setItem(markKey, JSON.stringify({ clientRequestId: op.clientRequestId, operationId: op.operationId }));
  const { createChatDraftIdentity, claimChatDraftOwnership, writeChatDraft } = await import('@/lib/chatDraftPersistence');
  const identity = createChatDraftIdentity(getRuntimeKey(), '/project', null, useSessionUIStore.getState().newSessionDraft.draftId)!;
  claimChatDraftOwnership(identity); writeChatDraft(identity, 'Held text', []);
  const original = opencodeClient.listNativeCreations;
  // SAFETY: a test double with the client method's own call shape.
  opencodeClient.listNativeCreations = (async () => [op]) as typeof original;
  try {
    const { resolveSentStart } = await import('@/sync/native-draft-sent');
    const outcome = await resolveSentStart(getRuntimeKey(), '/project', identity.draftId!);
    expect(outcome).toBe('cancelled');
    await act(async () => root.render(<NativeCreationNotice native={native([], [])} draftOpen sent="cancelled" />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(nativeCreationI18n.en['chat.nativeCreation.sentStoppedBy'].replace('{name}', 'Kate'));
  } finally { opencodeClient.listNativeCreations = original; localStorage.clear(); }
});

// smarty-code#523 on 3.45 (17:59Z run): the person sent into a start, left and came back; the sent text is locked and the
// notice offers Stop for that start. Stop settles it on the server; the text must then come back at once (the stopper
// named), not stay locked until "check again" because this tab still held its own Send attempt.
test('Stop on the start a sent text is locked to resolves that text at once, even while this tab held its own send', async () => {
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { holdSentStart, sentStartStoppedBy } = await import('@/sync/native-draft-sent');
  const { createChatDraftIdentity, claimChatDraftOwnership, writeChatDraft } = await import('@/lib/chatDraftPersistence');
  const op = { ...blocking('9999cccc-sent', -1), phase: 'unavailable' as const };
  const stopped = { ...op, phase: 'cancelled' as const, stoppedBy: { issuer: 'https://code.example', subject: 'kate-1', name: 'Kate' } };
  const markKey = `oc.nativeCreation.sent:${JSON.stringify([getRuntimeKey(), '/project'])}`;
  const identity = createChatDraftIdentity(getRuntimeKey(), '/project', null, useSessionUIStore.getState().newSessionDraft.draftId)!;
  claimChatDraftOwnership(identity); writeChatDraft(identity, 'Held text', []);
  localStorage.setItem(markKey, JSON.stringify({ clientRequestId: op.clientRequestId, operationId: op.operationId }));
  holdSentStart(op.clientRequestId!); // This tab's own Send attempt for it is still open.
  const originals = { abandon: opencodeClient.abandonNativeCreation, list: opencodeClient.listNativeCreations };
  // SAFETY: test doubles with the client methods' own call shapes.
  opencodeClient.abandonNativeCreation = (async () => stopped) as typeof originals.abandon;
  opencodeClient.listNativeCreations = (async () => [stopped]) as typeof originals.list;
  try {
    await act(async () => root.render(<NativeCreationNotice native={native([op], [])} draftOpen sent="pending" />));
    await act(async () => { stopButton()!.click(); await new Promise(done => setTimeout(done, 50)); });
    expect(localStorage.getItem(markKey)).toBeNull(); // Settled: the text is no longer locked to the start.
    expect(sentStartStoppedBy(getRuntimeKey(), '/project')).toBe('Kate');
  } finally { Object.assign(opencodeClient, { abandonNativeCreation: originals.abandon, listNativeCreations: originals.list }); localStorage.clear(); }
});

// smarty-code#849: on the sent path too, your own stop reads "You stopped this start"; another person's names them.
for (const [who, subject, expected] of [['you', 'kate-1', 'You stopped this start. Your text is back in the draft.'],
  ['another person', 'bob-2', 'This message was not sent: Kate stopped its session start. Your text is back in the draft.']] as const) {
  test(`the sent text's line after a stop by ${who}`, async () => {
    const { getRuntimeKey } = await import('@/lib/runtime-switch');
    const { holdSentStart } = await import('@/sync/native-draft-sent');
    const { useHumanSelf } = await import('@/lib/humanSelf');
    const { createChatDraftIdentity, claimChatDraftOwnership, writeChatDraft } = await import('@/lib/chatDraftPersistence');
    const op = { ...blocking(`9999dddd-${subject}`, -1), phase: 'unavailable' as const };
    const stopped = { ...op, phase: 'cancelled' as const, stoppedBy: { issuer: 'https://code.example', subject: 'kate-1', name: 'Kate' } };
    const markKey = `oc.nativeCreation.sent:${JSON.stringify([getRuntimeKey(), '/project'])}`;
    const identity = createChatDraftIdentity(getRuntimeKey(), '/project', null, useSessionUIStore.getState().newSessionDraft.draftId)!;
    claimChatDraftOwnership(identity); writeChatDraft(identity, 'Held text', []);
    localStorage.setItem(markKey, JSON.stringify({ clientRequestId: op.clientRequestId, operationId: op.operationId }));
    holdSentStart(op.clientRequestId!);
    const originals = { abandon: opencodeClient.abandonNativeCreation, list: opencodeClient.listNativeCreations };
    // SAFETY: test doubles with the client methods' own call shapes.
    opencodeClient.abandonNativeCreation = (async () => stopped) as typeof originals.abandon;
    opencodeClient.listNativeCreations = (async () => [stopped]) as typeof originals.list;
    useHumanSelf.setState({ subject });
    try {
      await act(async () => root.render(<NativeCreationNotice native={native([op], [])} draftOpen sent="pending" />));
      await act(async () => { stopButton()!.click(); await new Promise(done => setTimeout(done, 50)); });
      await act(async () => root.render(<NativeCreationNotice native={native([], [])} draftOpen sent="cancelled" />));
      expect(host.textContent).toContain(expected);
    } finally { Object.assign(opencodeClient, { abandonNativeCreation: originals.abandon, listNativeCreations: originals.list });
      localStorage.clear(); useHumanSelf.setState({ subject: undefined }); }
  });
}

// openchamber#357 review 1: a real LockManager releases a lock only after the request's own promise settles, a tick after
// its callback's promise resolved (checked in headless Chrome 153 and Node 24): query() still reports it held meanwhile.
// This manager keeps that ordering, so the held-own-send Stop must await the release before it reads the lock.
test('Stop on a start this tab still held its send for: the text resolves after the browser lock is really released', async () => {
  const held = new Set<string>();
  const manager = {
    request: (name: string, ...rest: unknown[]) => {
      const callback = rest.at(-1) as (lock: unknown) => Promise<unknown>;
      held.add(name);
      return Promise.resolve(callback({ name })).then(async value => { await new Promise(done => setTimeout(done, 5)); held.delete(name); return value; });
    },
    query: async () => ({ held: [...held].map(name => ({ name })), pending: [] }),
  };
  Object.defineProperty(navigator, 'locks', { value: manager, configurable: true });
  try {
    const { getRuntimeKey } = await import('@/lib/runtime-switch');
    const { holdSentStart, sentStartStoppedBy } = await import('@/sync/native-draft-sent');
    const { createChatDraftIdentity, claimChatDraftOwnership, writeChatDraft } = await import('@/lib/chatDraftPersistence');
    const op = { ...blocking('aaaa1111-lock', -1), phase: 'unavailable' as const };
    const stopped = { ...op, phase: 'cancelled' as const, stoppedBy: { issuer: 'https://code.example', subject: 'kate-1', name: 'Kate' } };
    const markKey = `oc.nativeCreation.sent:${JSON.stringify([getRuntimeKey(), '/project'])}`;
    const identity = createChatDraftIdentity(getRuntimeKey(), '/project', null, useSessionUIStore.getState().newSessionDraft.draftId)!;
    claimChatDraftOwnership(identity); writeChatDraft(identity, 'Held text', []);
    localStorage.setItem(markKey, JSON.stringify({ clientRequestId: op.clientRequestId, operationId: op.operationId }));
    holdSentStart(op.clientRequestId!);
    expect(held.has(`oc.nativeCreation.sending:${op.clientRequestId}`)).toBe(true); // This tab's own Send holds the real lock.
    const originals = { abandon: opencodeClient.abandonNativeCreation, list: opencodeClient.listNativeCreations };
    // SAFETY: test doubles with the client methods' own call shapes.
    opencodeClient.abandonNativeCreation = (async () => stopped) as typeof originals.abandon;
    opencodeClient.listNativeCreations = (async () => [stopped]) as typeof originals.list;
    try {
      await act(async () => root.render(<NativeCreationNotice native={native([op], [])} draftOpen sent="pending" />));
      await act(async () => { stopButton()!.click(); await new Promise(done => setTimeout(done, 80)); });
      expect(held.size).toBe(0);
      expect(localStorage.getItem(markKey)).toBeNull(); // Resolved, not "pending" behind a lock that was still releasing.
      expect(sentStartStoppedBy(getRuntimeKey(), '/project')).toBe('Kate');
    } finally { Object.assign(opencodeClient, { abandonNativeCreation: originals.abandon, listNativeCreations: originals.list }); }
  } finally { Reflect.deleteProperty(navigator, 'locks'); localStorage.clear(); }
});

test('a late read of an older start never names the wrong person for a newer one', async () => {
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { resolveSentStart, sentStartStoppedBy } = await import('@/sync/native-draft-sent');
  const { createChatDraftIdentity, claimChatDraftOwnership, writeChatDraft } = await import('@/lib/chatDraftPersistence');
  const by = (name: string) => ({ issuer: 'https://code.example', subject: name.toLowerCase(), name });
  const older = { ...blocking('4444dddd-older', -1), phase: 'cancelled' as const, stoppedBy: by('Kate') };
  const newer = { ...blocking('5555eeee-newer', -1), phase: 'cancelled' as const, stoppedBy: by('Bob') };
  const markKey = `oc.nativeCreation.sent:${JSON.stringify([getRuntimeKey(), '/project'])}`;
  const identity = createChatDraftIdentity(getRuntimeKey(), '/project', null, useSessionUIStore.getState().newSessionDraft.draftId)!;
  claimChatDraftOwnership(identity); writeChatDraft(identity, 'Held text', []);
  localStorage.setItem(markKey, JSON.stringify({ clientRequestId: older.clientRequestId, operationId: older.operationId }));
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = opencodeClient.listNativeCreations;
  let reads = 0;
  // SAFETY: a test double with the client method's own call shape.
  opencodeClient.listNativeCreations = (async () => { if (reads++ === 0) { await held; return [older]; } return [newer]; }) as typeof original;
  try {
    const late = resolveSentStart(getRuntimeKey(), '/project', identity.draftId!); // Reads the older start; its answer waits.
    await new Promise(done => setTimeout(done, 5));
    localStorage.setItem(markKey, JSON.stringify({ clientRequestId: newer.clientRequestId, operationId: newer.operationId }));
    expect(await resolveSentStart(getRuntimeKey(), '/project', identity.draftId!)).toBe('cancelled'); // Bob stopped the newer.
    release(); await late;
    expect(sentStartStoppedBy(getRuntimeKey(), '/project')).toBe('Bob');
  } finally { opencodeClient.listNativeCreations = original; localStorage.clear(); }
});
