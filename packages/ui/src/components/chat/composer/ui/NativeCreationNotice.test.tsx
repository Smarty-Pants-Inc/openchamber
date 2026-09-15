import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import type { useNativeCreation } from '../state/useNativeCreation';

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en, params: Record<string, string> = {}) => {
  const text = nativeCreationI18n.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name);
} }) }));
// Button's shared class helper imports search; this isolated static render never searches.
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
const { NativeCreationNotice } = await import('./NativeCreationNotice');
const native: ReturnType<typeof useNativeCreation> = { mode: 'ordinary', session: null, creation: null,
  canCreate: true, refresh: async () => {}, describeError: () => 'Inspect w1:p2 /native-one/session.jsonl. Do not retry automatically.',
  create: async () => {}, beforeSend: async () => {} };
const render = (value = native) => renderToStaticMarkup(<NativeCreationNotice native={value} draftOpen />);

test('create-only action is a separate non-submit button without a model requirement', () => {
  const html = render();
  expect(html).toContain('type="button"');
  expect(html).toContain('Create native Pi session');
  expect(html).not.toContain('disabled=""');
  expect(render({ ...native, mode: 'legacy' })).toBe('');
  expect(render({ ...native, canCreate: false })).toContain('disabled=""');
});

test('native attachment shows the returned model and original-terminal readiness, not a submit action', () => {
  const html = render({ ...native, session: { id: '01234567-1234-4234-9234-012345678901', slug: 'native', projectID: 'p',
    directory: '/project', title: 'Pi', version: '1', time: { created: 1, updated: 1 },
    nativeCreation: { model: { providerID: 'native-provider', modelID: 'native-model' }, inputReady: false } } });
  expect(html).toContain('native-provider/native-model');
  expect(html).toContain('/code-ready');
  expect(html).not.toContain('<button');
});

test('known pre-create failure exposes read-only connection recovery, while checking hides Create', () => {
  const failure: ReturnType<typeof useNativeCreation> = { ...native, creation: { status: 'failed', runtimeKey: 'test', draftId: 1,
    directory: '/project', projectId: 'p', submitted: false, error: new NativeCreationError('unavailable') } };
  const html = render(failure);
  expect(html).toContain('Check connection');
  expect(html).not.toContain('Create native Pi session');
  expect(html).toContain('type="button"');
  expect(render({ ...failure, creation: { status: 'checking', runtimeKey: 'test', draftId: 1, directory: '/project', projectId: 'p' } })).not.toContain('<button');
});

test('unknown recovery details reach an alert with no retry control', () => {
  const html = render({ ...native, creation: { status: 'failed', runtimeKey: 'test', draftId: 1,
    directory: '/project', projectId: 'p', submitted: true, error: new NativeCreationError('unknown') } });
  expect(html).toContain('role="alert"');
  expect(html).toContain('w1:p2 /native-one/session.jsonl');
  expect(html).toContain('Do not retry automatically');
  expect(html).not.toContain('<button');
});
