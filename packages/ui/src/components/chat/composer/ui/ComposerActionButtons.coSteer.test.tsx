import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { ComposerActionButtons } from './ComposerActionButtons';

// Co-steer (MVP 1 G5): while an ordinary session works, the button above Stop is a Send, not a Queue.
const render = async (sendWhileWorking: boolean) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    let sends = 0;
    try {
        await act(async () => root.render(<I18nProvider>
            <ComposerActionButtons isMobile={false} footerIconButtonClass="b" sendIconSizeClass="s" stopIconSizeClass="t"
                canSend canAbort hasContent currentSessionId="ordinary-1" newSessionDraftOpen={false}
                onPrimaryAction={() => {}} onQueueMessage={() => { sends += 1; }} sendWhileWorking={sendWhileWorking} onAbort={() => {}} />
        </I18nProvider>));
        const labels = [...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'));
        const upper = container.querySelector<HTMLButtonElement>('button.absolute');
        const rotated = Boolean(upper?.querySelector('.-rotate-90'));
        await act(async () => { upper?.click(); });
        return { labels, rotated, sends };
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
        }
        await win.happyDOM.close();
    }
};

test('an ordinary session working shows Send now above Stop, and it sends', async () => {
    const result = await render(true);
    expect(result.labels).toEqual(['Send now (delivered while the agent works)', 'Stop generating']);
    expect(result.rotated).toBe(false);
    expect(result.sends).toBe(1);
});

test('any other working session keeps Queue above Stop', async () => {
    const result = await render(false);
    expect(result.labels[0]).toBe('Queue message');
    expect(result.rotated).toBe(true);
});
