import React from 'react';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// Static Button rendering does not search. The installed test dependency closure has no fuse.js.
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
const { I18nProvider } = await import('@/lib/i18n');
const { useNativeCreation } = await import('../state/useNativeCreation');
const { NativeCreationNotice } = await import('./NativeCreationNotice');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { prepareNativeDraft } = await import('@/sync/native-draft-creation');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { directory, nativeDraftFixture, session } = await import('@/sync/native-draft-fixture');
let fixture: ReturnType<typeof nativeDraftFixture>;
afterEach(() => fixture?.dispose());

function ComposerNotice() {
  const state = useSessionUIStore.getState();
  const native = useNativeCreation(state.newSessionDraft, state.currentSessionId, state.newSessionDraft.directoryOverride ?? undefined, getRuntimeKey());
  return <NativeCreationNotice native={native} draftOpen={state.newSessionDraft.open} />;
}

const render = () => renderToStaticMarkup(<I18nProvider><ComposerNotice /></I18nProvider>);

for (const outcome of ['created', 'unknown'] as const) test(`real hook/notice remount restores ${outcome} A after creating B`, async () => {
  fixture = nativeDraftFixture();
  const detail = 'Inspect native-A w1:p2 /private/native-A/session.jsonl. Do not retry automatically.';
  if (outcome === 'unknown') fixture.handlers.create = async () => Response.json({ name: 'APIError', data: { message: detail, isRetryable: false } }, { status: 503 });
  await prepareNativeDraft().catch(() => {});
  // SSR normally reads initial hydration state. Exercise each real hook with its client snapshot,
  // without claiming DOM effects, browser subscriptions or hydration behavior.
  const serverSnapshot = spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try {
    const first = render();
    fixture.target('b', '/native-project-b');
    fixture.handlers.create = async () => Response.json({ ...session, id: '01234567-1234-4234-9234-012345678902', directory: '/native-project-b' });
    await prepareNativeDraft();
    expect(render()).not.toBe(first);
    fixture.target('a', directory);
    expect(render()).toBe(first);
    expect(first).toContain(outcome === 'created' ? session.id : detail);
    expect(first).not.toContain('Create native Pi session');
    if (outcome === 'unknown') expect(first).not.toContain('Check connection');
    await prepareNativeDraft(); expect(fixture.creates()).toHaveLength(2);
  } finally { serverSnapshot.mockRestore(); }
});
