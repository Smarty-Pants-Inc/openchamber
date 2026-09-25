import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

// smarty-code#302: a phone user sees Voice call on the collapsed pill, without expanding the composer.
mock.module('@/components/chat/SessionVoiceCall', () => ({
    SessionVoiceCall: ({ sessionId, directory }: { sessionId: string; directory?: string }) =>
        <button type="button" data-voice-call={`${sessionId}@${directory}`}>Voice call</button>,
}));

const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
const { SyncProvider } = await import('@/sync/sync-context');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { I18nProvider } = await import('@/lib/i18n');
const { getDefaultTheme } = await import('@/lib/theme/themes');
const { MobilePillComposer } = await import('./MobilePillComposer');

const renderPill = async (options: { hasContent: boolean; newSessionDraftOpen: boolean; canAbort?: boolean }): Promise<string[]> => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(
        <SyncProvider directory="/fixture" sdk={createOpencodeClient({ baseUrl: "http://opencode.test", fetch: (async () => new Response("[]", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch })}>
        <ThemeSystemProvider>
        <I18nProvider>
            <MobilePillComposer
                directory="/fixture"
                message={options.hasContent ? 'Draft message' : ''}
                sessionId={options.newSessionDraftOpen ? null : 'session-1'}
                newSessionDraftOpen={options.newSessionDraftOpen}
                hasContent={options.hasContent}
                isVSCode={false}
                canAbort={options.canAbort ?? false}
                footerIconButtonClass="icon-button"
                iconSizeClass="icon-size"
                sendIconSizeClass="send-icon-size"
                stopIconSizeClass="stop-icon-size"
                theme={getDefaultTheme(false)}
                onExpand={() => {}}
                onApplySuggestion={() => {}}
                onPrimaryAction={() => {}}
                onQueueMessage={() => {}}
                onNewSession={() => {}}
                onPickLocalFiles={() => {}}
                onOpenIssuePicker={() => {}}
                onOpenPrPicker={() => {}}
                onOpenAttachSheet={() => {}}
                onStartDictation={() => {}}
                onAbort={() => {}}
            />
        </I18nProvider>
        </ThemeSystemProvider>
        </SyncProvider>));
        return [...container.querySelectorAll('[data-voice-call]')].map(node => node.getAttribute('data-voice-call') ?? '');
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
        }
    }
};

test('the collapsed pill shows Voice call for the open session', async () => {
    expect(await renderPill({ hasContent: false, newSessionDraftOpen: false })).toEqual(['session-1@/fixture']);
});

test('a new-session draft (no session yet) shows no Voice call on the pill', async () => {
    expect(await renderPill({ hasContent: false, newSessionDraftOpen: true })).toEqual([]);
});
