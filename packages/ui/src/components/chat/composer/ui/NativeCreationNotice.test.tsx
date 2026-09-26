import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import type { useNativeCreation } from '../state/useNativeCreation';

const i18n = await import('@/lib/i18n');
mock.module('@/lib/i18n', () => ({ ...i18n, useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en, params: Record<string, string> = {}) => {
  const text = nativeCreationI18n.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name);
} }) }));
// Button's shared class helper imports search; this isolated static render never searches.
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
const { NativeCreationNotice } = await import('./NativeCreationNotice');
const native: ReturnType<typeof useNativeCreation> = { mode: 'ordinary', session: null, creation: null, canAbandon: false,
  refresh: async () => {}, cancel: async () => {}, describeError: error => nativeCreationI18n.en[`chat.nativeCreation.${(error as NativeCreationError).code}` as keyof typeof nativeCreationI18n.en],
  beforeSend: async () => undefined, operations: [] };
const render = (value = native) => renderToStaticMarkup(<NativeCreationNotice native={value} draftOpen />);
const failed = (code: 'unavailable' | 'unknown', submitted: boolean): ReturnType<typeof useNativeCreation> => ({ ...native,
  creation: { status: 'failed', runtimeKey: 'test', draftId: 1, directory: '/project', projectId: 'p', submitted, error: new NativeCreationError(code) } });

// smarty-code#126: Send starts a new draft's session itself; there is no separate step to show.
test('a ready new-session draft shows nothing extra: no create button, no jargon', () => {
  expect(render()).toBe('');
  expect(render({ ...native, mode: 'legacy' })).toBe('');
  expect(render({ ...native, mode: 'loading' })).toBe('');
});

test('a failed start says what happened and what to do in plain words, with one Check again action', () => {
  for (const html of [render(failed('unavailable', false)), render(failed('unknown', true))]) {
    expect(html).toContain('role="alert"');
    expect(html).toContain('Nothing was sent, and your message is still here.');
    expect(html).toContain('Check again');
    expect(/native|\/code-ready|Inspect Herdr|admitted|create-only/i.test(html)).toBe(false);
  }
});

test('while the session is starting the line says so; an unreachable server says the message waits', () => {
  expect(render({ ...native, creation: { status: 'creating', runtimeKey: 'test', draftId: 1, directory: '/project', projectId: 'p' } }))
    .toContain('Starting a new session in this project');
  expect(render({ ...native, mode: 'unavailable' })).toContain('Cannot reach the server right now');
});

test('every plain-language string avoids the old jargon', () => {
  for (const [locale, strings] of Object.entries(nativeCreationI18n)) {
    for (const text of Object.values(strings)) expect(`${locale}: ${/native|\/code-ready|admitted|create-only|Inspect Herdr/i.test(text)}`).toBe(`${locale}: false`);
  }
});

test('while projects are still being discovered the line says so, never that the server cannot be reached (G13)', () => {
  const html = render({ ...native, mode: 'discovering' as never });
  expect(html).toContain('Loading projects…');
  expect(html).not.toContain('Cannot reach the server');
  expect(html).not.toContain('Check again');
});
