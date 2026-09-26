import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import type { useNativeCreation } from '../state/useNativeCreation';

const i18n = await import('@/lib/i18n');
// SAFETY: every key the notice asks for is a string entry of the English creation messages.
mock.module('@/lib/i18n', () => ({ ...i18n, useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en) => nativeCreationI18n.en[key] ?? key }) }));
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
let starting = false;
const start = await import('@/sync/native-draft-start');
mock.module('@/sync/native-draft-start', () => ({ ...start, useNativeDraftStarting: () => starting, useUnresolvedNativeStart: () => false }));
const { NativeCreationNotice } = await import('./NativeCreationNotice');
const { useSessionUIStore } = await import('@/sync/session-ui-store');

// smarty-code#126 (3.18 walk): a start that could not be read is not failed and not settled.
const operation: NativeCreationState = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directory: '/project', generation: 'g',
  revision: 2, phase: 'awaiting-trust', expiresAt: Date.now() + 60_000, canInitialReady: false };
const native = (unreadable: boolean, phase: NativeCreationState['phase'] = 'awaiting-trust', canAbandon = false): ReturnType<typeof useNativeCreation> => ({
  mode: 'ordinary', session: null, canAbandon, refresh: async () => {}, cancel: async () => {}, describeError: () => '',
  beforeSend: async () => undefined, operations: [], refusal: null,
  creation: { status: 'pending', runtimeKey: 'test', draftId: 1, directory: '/project', projectId: 'p',
    operation: { ...operation, phase }, unreadable } });
const render = (value: ReturnType<typeof useNativeCreation>) => renderToStaticMarkup(<NativeCreationNotice native={value} draftOpen />);

test('after Send stops on an unreadable start, the outcome is unknown and Check again only reads', () => {
  starting = false;
  for (const html of [render(native(true)), render(native(false, 'unavailable'))]) {
    expect(html).toContain('role="alert"');
    expect(html).toContain(nativeCreationI18n.en['chat.nativeCreation.unknown']);
    expect(html).toContain('Check again');
    expect(html).not.toContain(nativeCreationI18n.en['chat.nativeCreation.recover']);
    // No escape to a second start: the gateway refuses one while this start is unsettled (OC#207 review).
    expect(html).not.toContain(nativeCreationI18n.en['chat.nativeCreation.startAgain']);
  }
  // A server that can abandon it (smarty-code#340) offers starting a new session instead, unless it already passed trust
  // (a real session, which the server refuses to abandon).
  expect(render(native(true, 'awaiting-trust', true))).toContain(nativeCreationI18n.en['chat.nativeCreation.startAgain']);
  for (const phase of ['starting', 'ready-required'] as const) {
    expect(render(native(true, phase, true))).not.toContain(nativeCreationI18n.en['chat.nativeCreation.startAgain']);
  }
});

test('text another tab sent (#117) is shown with what became of it, never as an ordinary draft', async () => {
  starting = false;
  const { Window } = await import('happy-dom');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  const win = new Window({ url: 'http://localhost' });
  const names = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, open: true, directoryOverride: '/project' } }));
  try {
    for (const [outcome, key] of [['pending', 'sentPending'], ['unknown', 'sentKeep'], ['stopped', 'sentStopped']] as const) {
      await act(async () => root.render(<NativeCreationNotice native={{ ...native(false), creation: null }} draftOpen sent={outcome} />));
      expect(host.textContent).toContain(nativeCreationI18n.en[`chat.nativeCreation.${key}`]);
      if (outcome === 'pending') expect(host.textContent).toContain('Check again');
    }
    // With a session here too (a Send refused after its start settled): the locked composer always shows its way out.
    const withSession = { ...native(false), creation: null, session: { id: 'ses_1' } } as unknown as ReturnType<typeof useNativeCreation>;
    await act(async () => root.render(<NativeCreationNotice native={withSession} draftOpen sent="unknown" />));
    expect(host.textContent).toContain(nativeCreationI18n.en['chat.nativeCreation.sentKeep']);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('while Send re-reads an unreadable start, Cancel is disabled: no reply is sent from an unknown state', () => {
  starting = true;
  const cancelDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>Cancel/.test(html);
  expect(cancelDisabled(render(native(true)))).toBe(true);
  expect(cancelDisabled(render(native(false)))).toBe(false);
  starting = false;
});
