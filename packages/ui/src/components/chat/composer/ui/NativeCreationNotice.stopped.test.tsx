import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { NativeCreationError, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import type { useNativeCreation } from '../state/useNativeCreation';

const i18n = await import('@/lib/i18n');
// SAFETY: every key the notice asks for is a string entry of the English creation messages.
mock.module('@/lib/i18n', () => ({ ...i18n, useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en, params?: Record<string, string>) =>
  (nativeCreationI18n.en[key] ?? key).replace(/\{(\w+)\}/g, (_: string, name: string) => params?.[name] ?? `{${name}}`) }) }));
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
const start = await import('@/sync/native-draft-start');
mock.module('@/sync/native-draft-start', () => ({ ...start, useNativeDraftStarting: () => false, useUnresolvedNativeStart: () => false }));
const { NativeCreationNotice } = await import('./NativeCreationNotice');

// smarty-code#634: a start that failed before launch settles 'cancelled' (the gateway's settleUnlaunched). The draft's
// record keeps status 'pending' with that stopped phase; the notice said it "has not finished starting" for good.
const operation: NativeCreationState = { operationId: 'a8622685-1259-42fa-9e77-dd133992703b', directory: '/project', generation: null,
  revision: 0, phase: 'cancelled', expiresAt: Date.now() + 60_000, canInitialReady: false };
const native = (phase: NativeCreationState['phase']): ReturnType<typeof useNativeCreation> => ({
  mode: 'ordinary', session: null, canAbandon: true, refresh: async () => {}, cancel: async () => {}, describeError: () => '',
  beforeSend: async () => undefined, operations: [], refusal: null, noteRefusal: () => new NativeCreationError('unavailable'),
  creation: { status: 'pending', runtimeKey: 'test', draftId: 1, directory: '/project', projectId: 'p', operation: { ...operation, phase } } });
const render = (value: ReturnType<typeof useNativeCreation>) => renderToStaticMarkup(<NativeCreationNotice native={value} draftOpen />);

test('a start that stopped (failed before launch, declined or expired) says it did not start, never that it is still starting', () => {
  for (const phase of ['cancelled', 'denied', 'expired'] as const) {
    const html = render(native(phase));
    expect(html).toContain(nativeCreationI18n.en['chat.nativeCreation.stopped']);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain(nativeCreationI18n.en['chat.nativeCreation.recover']);
    expect(html).not.toContain(nativeCreationI18n.en['chat.nativeCreation.starting']);
  }
});

test('control: a start still in progress keeps its own line', () => {
  expect(render(native('awaiting-trust'))).toContain(nativeCreationI18n.en['chat.nativeCreation.recover']);
  expect(render(native('awaiting-trust'))).not.toContain(nativeCreationI18n.en['chat.nativeCreation.stopped']);
});

test('smarty-code#751: an expired start names what it was waiting for; one without a recorded reason, or not expired, does not', () => {
  const at = (phase: NativeCreationState['phase'], waitingFor?: string): ReturnType<typeof useNativeCreation> => ({ ...native(phase),
    creation: { status: 'pending', runtimeKey: 'test', draftId: 1, directory: '/project', projectId: 'p', operation: { ...operation, phase, ...(waitingFor ? { waitingFor } : {}) } } });
  const html = render(at('expired', 'terminal input received'));
  expect(html).toContain(nativeCreationI18n.en['chat.nativeCreation.stopped']);
  expect(html).toContain('It was waiting for: terminal input received.');
  expect(render(at('expired'))).not.toContain('It was waiting for');
  expect(render(at('cancelled', 'x'))).not.toContain('It was waiting for');
});

// smarty-code#849: your own stop reads "You stopped this start", never your own name; another person's stop, or a start
// that stopped for another reason, keeps its line.
test('your own stop says "You stopped this start"; another person\'s stop, or no sign-in, keeps the plain line', async () => {
  const { useHumanSelf } = await import('@/lib/humanSelf');
  const stopped = (subject: string): ReturnType<typeof useNativeCreation> => ({ ...native('cancelled'), creation: { status: 'pending',
    runtimeKey: 'test', draftId: 1, directory: '/project', projectId: 'p', operation: { ...operation, phase: 'cancelled',
      stoppedBy: { issuer: 'https://code.example', subject, name: 'Code Test2' } } } });
  const you = nativeCreationI18n.en['chat.nativeCreation.stoppedByYou'];
  // A client render (the store's live state; a static render reads its initial state).
  const { Window } = await import('happy-dom'); const { createRoot } = await import('react-dom/client'); const { act } = await import('react');
  const win = new Window({ url: 'http://localhost' });
  const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const render = (value: ReturnType<typeof useNativeCreation>) => {
    const host = document.createElement('div'); const root = createRoot(host);
    act(() => { root.render(<NativeCreationNotice native={value} draftOpen />); });
    const html = host.innerHTML; act(() => root.unmount()); return html;
  };
  try {
    useHumanSelf.setState({ subject: 'me-1' });
    expect(render(stopped('me-1'))).toContain(you);
    expect(render(stopped('me-1'))).not.toContain('Code Test2');
    expect(render(stopped('kate-1'))).toContain(nativeCreationI18n.en['chat.nativeCreation.stopped']);
    expect(render(native('expired'))).not.toContain(you);
    useHumanSelf.setState({ subject: undefined }); // Not signed in (or not read yet): never "you".
    expect(render(stopped('me-1'))).not.toContain(you);
  } finally {
    useHumanSelf.setState({ subject: undefined });
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    await win.happyDOM.close();
  }
});
