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
