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

// smarty-code#126 (3.18 walk): a start that could not be read is not failed and not settled.
const operation: NativeCreationState = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directory: '/project', generation: 'g',
  revision: 2, phase: 'awaiting-trust', expiresAt: Date.now() + 60_000, canInitialReady: false };
const native = (unreadable: boolean, phase: NativeCreationState['phase'] = 'awaiting-trust'): ReturnType<typeof useNativeCreation> => ({
  mode: 'ordinary', session: null, refresh: async () => {}, cancel: async () => {}, describeError: () => '',
  beforeSend: async () => undefined, operations: [],
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
});

test('while Send re-reads an unreadable start, Cancel is disabled: no reply is sent from an unknown state', () => {
  starting = true;
  const cancelDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>Cancel/.test(html);
  expect(cancelDisabled(render(native(true)))).toBe(true);
  expect(cancelDisabled(render(native(false)))).toBe(false);
  starting = false;
});
