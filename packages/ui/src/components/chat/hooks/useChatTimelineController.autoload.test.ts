import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import { useChatTimelineController, type UseChatTimelineControllerResult } from './useChatTimelineController';
import type { MessageListHandle } from '../MessageList';

// smarty-code#583, review/astra on OC#303: after an older page lands, the next one may load at once, but only
// after a load that ADDED rows. A failed or empty load waits for the user's next scroll (no retry loop).

const installMinimalDom = () => {
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const set = (name: string, value: unknown) => {
        saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const doc: Record<string, unknown> = { nodeType: 9, defaultView: globalThis, activeElement: null,
        addEventListener: () => undefined, removeEventListener: () => undefined };
    const container = { nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: doc, addEventListener: () => undefined, removeEventListener: () => undefined };
    doc.documentElement = container;
    doc.body = container;
    set('document', doc);
    set('window', globalThis);
    set('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    set('Element', ElementStub);
    set('HTMLElement', ElementStub);
    set('HTMLIFrameElement', ElementStub);
    set('IS_REACT_ACT_ENVIRONMENT', true);
    set('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
    set('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    return {
        container: container as unknown as Element,
        restore: () => {
            for (const [name, d] of saved) {
                if (d) Object.defineProperty(globalThis, name, d);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

const user = (id: string, created: number) => ({
    info: { id, sessionID: 's', role: 'user', time: { created } } as Message, parts: [],
});

/** Runs one user-started older load, then lets frames and renders settle; returns how many pages were requested. */
const run = async (page: (call: number) => 'fail' | 'empty' | 'grow') => {
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    // At the top of the timeline (scrollTop under the history threshold), not pinned.
    const scrollRef = { current: { scrollTop: 0, scrollHeight: 1000, clientHeight: 500, firstElementChild: null } as unknown as HTMLDivElement };
    const messageListRef = { current: {
        captureViewportAnchor: () => null, restoreViewportAnchor: () => true, isHistoryVirtualized: () => false,
        scrollToTurnId: () => false, scrollToMessageId: () => false,
    } as unknown as MessageListHandle };
    let messages = [user('m100', 100)];
    let calls = 0;
    let controller!: UseChatTimelineControllerResult;
    const Harness = () => {
        controller = useChatTimelineController({
            sessionId: 's', sessionKey: 'runtime\nA\ns', messages,
            historyMeta: { limit: 1, complete: false, loading: false },
            scrollRef, messageListRef,
            loadMoreMessages: async () => {
                calls += 1;
                const kind = page(calls);
                if (kind === 'fail') throw new Error('read failed');
                if (kind === 'grow') {
                    messages = [user(`m${100 - calls}`, 100 - calls), ...messages];
                    root.render(React.createElement(Harness));
                }
            },
            goToBottom: () => undefined, releaseAutoFollow: () => undefined, isPinned: false, showScrollButton: false,
        });
        return null;
    };
    try {
        await act(async () => root.render(React.createElement(Harness)));
        // Started, not awaited inside act: act flushes the page's re-render between the frames below.
        act(() => { void controller.loadEarlier({ userInitiated: true }).catch(() => undefined); });
        // Many frames and render waits: a retry loop would keep requesting pages here.
        for (let i = 0; i < 40; i += 1) {
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        }
        return calls;
    } finally {
        await act(async () => root.unmount());
        dom.restore();
    }
};

describe('older history after a load (smarty-code#583)', () => {
    test('a failed load does not retry on its own', async () => {
        expect(await run(() => 'fail')).toBe(1);
    });

    test('an empty page does not retry on its own', async () => {
        expect(await run(() => 'empty')).toBe(1);
    });

    test('a page that added rows chains the next one at once, which stops when that page is empty', async () => {
        expect(await run((call) => (call === 1 ? 'grow' : 'empty'))).toBe(2);
    });
});
