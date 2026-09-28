import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import { useChatTimelineController, type UseChatTimelineControllerResult } from './useChatTimelineController';
import { PREPEND_ANCHOR_HOLD } from '../lib/scroll/anchorHold';
import type { MessageListHandle } from '../MessageList';

// smarty-code#583: the list keeps a prepend's place by row key, but an older page can regroup or resize the reader's
// own row. After each older page the controller must hold the reader's captured message at its offset.

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

describe('older history keeps the reader in place (smarty-code#583)', () => {
    test('after an older page lands, the reader\'s captured message is held at its offset', async () => {
        const dom = installMinimalDom();
        const root = createRoot(dom.container);
        const scrollRef = { current: { scrollTop: 0, scrollHeight: 1000, clientHeight: 500, firstElementChild: null } as unknown as HTMLDivElement };
        const anchor = { messageId: 'm100', offsetTop: 120 };
        const holds: unknown[][] = [];
        const messageListRef = { current: {
            captureViewportAnchor: () => anchor,
            restoreViewportAnchor: () => true,
            holdViewportAnchor: (...args: unknown[]) => { holds.push(args); },
            isHistoryVirtualized: () => true,
            scrollToTurnId: () => false, scrollToMessageId: () => false,
        } as unknown as MessageListHandle };
        let messages = [user('m100', 100)];
        let controller!: UseChatTimelineControllerResult;
        const Harness = () => {
            controller = useChatTimelineController({
                sessionId: 's', sessionKey: 'runtime\nA\ns', messages,
                historyMeta: { limit: 1, complete: false, loading: false },
                scrollRef, messageListRef,
                loadMoreMessages: async () => {
                    messages = [user('m099', 99), ...messages]; // one older page
                    root.render(React.createElement(Harness));
                },
                goToBottom: () => undefined, releaseAutoFollow: () => undefined, isPinned: false, showScrollButton: false,
            });
            return null;
        };
        try {
            await act(async () => root.render(React.createElement(Harness)));
            act(() => { void controller.loadEarlier({ userInitiated: true }); });
            for (let i = 0; i < 10; i += 1) {
                await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
            }
            expect(holds).toEqual([[anchor, PREPEND_ANCHOR_HOLD]]);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });
});
