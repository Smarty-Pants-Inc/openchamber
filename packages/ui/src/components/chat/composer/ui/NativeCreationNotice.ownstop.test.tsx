import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { NativeCreationError, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import type { useNativeCreation } from '../state/useNativeCreation';

// smarty-code#587 (3.40 run): the person who pressed New session sat for 95 s behind their OWN "Starting a new
// session…" line with a greyed Cancel (its Pi frozen) and no way out but a reload. That start offers Stop after the
// same threshold as a blocking start (#523): at once past its expiry, else after the grace.
const i18n = await import('@/lib/i18n');
// SAFETY: every key the notice asks for is a string entry of the English creation messages.
mock.module('@/lib/i18n', () => ({ ...i18n, useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en, params: Record<string, string> = {}) =>
  (nativeCreationI18n.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name) }) }));
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
const start = await import('@/sync/native-draft-start');
// Switchable: the wait's limit (LIMIT_MS) ends "starting" while the start is still unsettled (the review's case).
let starting = true;
mock.module('@/sync/native-draft-start', () => ({ ...start, useNativeDraftStarting: () => starting, useUnresolvedNativeStart: () => false }));
const { NativeCreationNotice } = await import('./NativeCreationNotice');

const STOP = nativeCreationI18n.en['chat.nativeCreation.stopStart'];
const own = (expiresIn: number, phase: NativeCreationState['phase'] = 'starting'): NativeCreationState => ({ operationId: 'e7c860b3-5ec1-4584-aace-9059d142edc3',
  directory: '/project', generation: 'g', revision: 1, phase, expiresAt: Date.now() + expiresIn, canInitialReady: false });
const native = (operation: NativeCreationState, canAbandon = true, unreadable = true, error?: NativeCreationError): ReturnType<typeof useNativeCreation> => ({
  mode: 'ordinary', session: null, canAbandon, refresh: async () => {}, cancel: async () => {}, describeError: () => '',
  beforeSend: async () => undefined, operations: [], refusal: null, noteRefusal: () => new NativeCreationError('unavailable'),
  creation: { status: 'pending', runtimeKey: 'test', draftId: 1, directory: '/project', projectId: 'p', operation, unreadable, error } });
const render = (value: ReturnType<typeof useNativeCreation>) => renderToStaticMarkup(<NativeCreationNotice native={value} draftOpen />);

test('the draft\'s own start that does not finish offers Stop, beside its (greyed) Cancel, once past its expiry', () => {
  const html = render(native(own(-1_000)));
  expect(html).toContain(nativeCreationI18n.en['chat.nativeCreation.starting']);
  expect(html).toContain(`>${STOP}</button>`);
  // smarty-code#1491: the visible label is plain; the start's id stays in its title and data attribute only.
  expect(html.replace(/<[^>]*>/g, '')).not.toContain('e7c860b3');
  expect(html).toContain('title="e7c860b3-5ec1-4584-aace-9059d142edc3"');
  expect(html).toContain('data-operation-id="e7c860b3-5ec1-4584-aace-9059d142edc3"');
});

test('within the grace, no Stop yet; a server that cannot abandon never offers it; a settled start has none', () => {
  // First seen now, far from expiry: the grace has not passed.
  expect(render(native(own(10 * 60_000, 'awaiting-trust')))).not.toContain(STOP);
  expect(render(native(own(-1_000), false))).not.toContain(STOP);
  expect(render(native(own(-1_000, 'cancelled')))).not.toContain(STOP);
});

test('the wait gives up at its limit but the start is still unsettled: the same start keeps its Stop (review of ce562a51)', () => {
  const op = own(-1_000), check = nativeCreationI18n.en['chat.nativeCreation.check'];
  try {
    expect(render(native(op))).toContain(STOP); // while starting
    starting = false; // the limit ended the wait; the operation stays pending
    const unreadable = render(native(op));
    expect(unreadable).toContain(nativeCreationI18n.en['chat.nativeCreation.unknown']);
    expect(unreadable).toContain(check);
    expect(unreadable).toContain(STOP);
    // Readable, still 'starting', no error: the recovery line keeps it too.
    const readable = render(native(op, true, false));
    expect(readable).toContain(nativeCreationI18n.en['chat.nativeCreation.recover']);
    expect(readable).toContain(STOP);
    // The limit's error on the pending start (required / unknown): Check, and Stop.
    const failed = render(native(op, true, false, new NativeCreationError('required')));
    expect(failed).toContain(check);
    expect(failed).toContain(STOP);
    // Never for a server that cannot abandon, nor a start that stopped.
    expect(render(native(op, false))).not.toContain(STOP);
    expect(render(native(own(-1_000, 'cancelled')))).not.toContain(STOP);
  } finally { starting = true; }
});
