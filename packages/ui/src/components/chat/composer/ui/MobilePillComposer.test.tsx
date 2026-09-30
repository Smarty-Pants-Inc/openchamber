import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { SyncProvider } from '@/sync/sync-context';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { getDefaultTheme } from '@/lib/theme/themes';

import { MobilePillComposer } from './MobilePillComposer';
import { pillSendDisabledReason } from './pillSendDisabledReason';

const renderPill = async (options: { hasContent: boolean; newSessionDraftOpen: boolean; canAbort?: boolean; unavailable?: string }) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    let primaryActions = 0;
    let queued = 0;
    try {
        await act(async () => root.render(
        <SyncProvider directory="/fixture" sdk={createOpencodeClient({ baseUrl: "http://opencode.test", fetch: async () => new Response("[]", { headers: { "content-type": "application/json" } }) })}>
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
                onPrimaryAction={() => { primaryActions += 1; }}
                onQueueMessage={() => { queued += 1; }}
                sendDisabledReason={options.unavailable}
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
        if (options.unavailable && options.hasContent) {
            // smarty-code#790: while its session is unavailable, neither Send (inline) nor the trailing Send/Queue
            // sends; both say why on hover.
            const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
                .filter((button) => button.getAttribute('title') === options.unavailable);
            expect(buttons.length).toBeGreaterThan(0);
            for (const button of buttons) {
                expect(button.disabled).toBe(true);
                await act(async () => { button.click(); });
            }
            expect(primaryActions + queued).toBe(0);
        } else if (options.hasContent && options.canAbort) {
            // While a turn runs the draft can only be queued, never sent past it.
            const queue = container.querySelector<HTMLButtonElement>('[aria-label="Queue message"]');
            expect(queue).not.toBeNull();
            await act(async () => { queue?.click(); });
            expect(queued).toBe(1);
            expect(primaryActions).toBe(0);
        } else if (options.hasContent) {
            const send = container.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
            expect(send).not.toBeNull();
            await act(async () => { send?.click(); });
            expect(primaryActions).toBe(1);
            expect(queued).toBe(0);
        }
        return container.innerHTML;
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

describe('MobilePillComposer', () => {
    // smarty-code#790 audit: on a phone the reason must be VISIBLE, not only a hover title (a tap on a disabled button
    // shows nothing): the collapsed composer says why Send is off while its session is unavailable, with or without text.
    const REASON = 'This session is unavailable right now. Send is off until it is back; your message stays here.';
    const visibleReason = (markup: string) => markup.match(/<p[^>]*data-testid="mobile-send-unavailable"[^>]*>([^<]*)<\/p>/)?.[1] ?? null;
    test('shows why Send is off as a visible line while the session is unavailable, with or without text', async () => {
        expect(visibleReason(await renderPill({ hasContent: true, newSessionDraftOpen: false, unavailable: REASON }))).toBe(REASON);
        expect(visibleReason(await renderPill({ hasContent: false, newSessionDraftOpen: false, unavailable: REASON }))).toBe(REASON);
    });
    test('shows no reason line when Send is available', async () => {
        expect(visibleReason(await renderPill({ hasContent: true, newSessionDraftOpen: false }))).toBeNull();
        expect(visibleReason(await renderPill({ hasContent: false, newSessionDraftOpen: false }))).toBeNull();
    });

    test('uses the inline action to send content while the session is idle', async () => {
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: false });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).toContain('aria-label="New chat"');
        expect(markup.indexOf('aria-label="Send message"')).toBeLessThan(markup.indexOf('aria-label="New chat"'));
    });

    test('uses the trailing action to queue content while the session is running', async () => {
        // The expanded composer shows a rotated send icon labelled "Queue
        // message" in this state; the collapsed pill must read the same.
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: false, canAbort: true });

        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).toContain('aria-label="Queue message"');
        expect(markup).toContain('-rotate-90');
        expect(markup).not.toContain('aria-label="Send message"');
        expect(markup).not.toContain('aria-label="New chat"');
        expect(markup.indexOf('aria-label="Stop generating"')).toBeLessThan(markup.indexOf('aria-label="Queue message"'));
    });

    test('uses the inline send action for content in a new-session draft', async () => {
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: true });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).toContain('w-0 opacity-0 overflow-hidden');
    });

    test('keeps the new-session action for an empty existing session', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: false });

        expect(markup).toContain('aria-label="New chat"');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('keeps the trailing action collapsed for an empty new-session draft', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: true });

        expect(markup).toContain('w-0 opacity-0 overflow-hidden');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('keeps abort and new-session actions while a session runs without content', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: false, canAbort: true });

        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).toContain('aria-label="New chat"');
        expect(markup).not.toContain('aria-label="Send message"');
    });
});

test('smarty-code#790: an unavailable session disables the collapsed Send, idle and working, with the reason', async () => {
    await renderPill({ hasContent: true, newSessionDraftOpen: false, unavailable: 'This session is unavailable right now.' });
    await renderPill({ hasContent: true, newSessionDraftOpen: false, canAbort: true, unavailable: 'This session is unavailable right now.' });
});

// openchamber#441 r3: a New session draft on a withdrawn project. The collapsed Send must be off too, with the reason
// shown; choosing an admitted project (another mode) turns it back on.
    const NOT_ADMITTED = 'That project is no longer available here. Choose another project for this new session.';
    const t = (key: string) => key === 'chat.nativeCreation.notAdmitted' ? NOT_ADMITTED : 'unavailable';
    test('a withdrawn-project draft: the collapsed Send is off and says why; an admitted project turns it back on', async () => {
        const reason = pillSendDisabledReason({ ordinaryUnavailable: false, newSessionDraftOpen: true, nativeMode: 'notAdmitted' }, t);
        expect(reason).toBe(NOT_ADMITTED);
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: true, unavailable: reason });
        expect(markup.match(/<p[^>]*data-testid="mobile-send-unavailable"[^>]*>([^<]*)<\/p>/)?.[1]).toBe(NOT_ADMITTED);
        expect(pillSendDisabledReason({ ordinaryUnavailable: false, newSessionDraftOpen: true, nativeMode: 'ordinary' }, t)).toBeUndefined();
        expect(pillSendDisabledReason({ ordinaryUnavailable: false, newSessionDraftOpen: false, nativeMode: 'notAdmitted' }, t)).toBeUndefined();
    });
