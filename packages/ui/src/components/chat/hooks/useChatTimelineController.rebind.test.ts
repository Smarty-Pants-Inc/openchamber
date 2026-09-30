import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
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

// openchamber#457 review 1, P2 2: when a session's positions arrive, the timeline is mounted anew and its scroll element
// is replaced (same session key, same scrollRef object). The controller's reader listeners must move to the new element:
// a reader who moves on the NEW scroller while an older page is pending is held where they are now.
const node = () => {
    const listeners = new Map<string, Set<() => void>>();
    return { listeners, scrollTop: 0, scrollHeight: 1000, clientHeight: 500, firstElementChild: null,
        addEventListener: (n: string, fn: () => void) => { (listeners.get(n) ?? listeners.set(n, new Set()).get(n)!).add(fn); },
        removeEventListener: (n: string, fn: () => void) => { listeners.get(n)?.delete(fn); },
        fire: (n: string) => { for (const fn of listeners.get(n) ?? []) fn(); } };
};

test('after the scroll element is replaced, reader moves on the new element still re-capture a pending page\'s anchor', async () => {
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const oldNode = node(), newNode = node();
    const scrollRef = { current: oldNode as unknown as HTMLDivElement };
    let scrollNode: unknown = oldNode;
    let anchor = { messageId: 'm100', offsetTop: 120 };
    const holds: unknown[][] = [];
    const messageListRef = { current: {
        captureViewportAnchor: () => anchor, restoreViewportAnchor: () => true,
        holdViewportAnchor: (...args: unknown[]) => { holds.push(args); },
        isHistoryVirtualized: () => true, scrollToTurnId: () => true, scrollToMessageId: () => true,
    } as unknown as MessageListHandle };
    let messages = [user('m100', 100)];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let controller!: UseChatTimelineControllerResult;
    const Harness = () => {
        controller = useChatTimelineController({
            sessionId: 's', sessionKey: 'runtime\nA\ns', messages,
            historyMeta: { limit: 1, complete: false, loading: false }, scrollRef, scrollNode: scrollNode as HTMLElement, messageListRef,
            loadMoreMessages: async () => { await gate; messages = [user('m099', 99), ...messages]; root.render(React.createElement(Harness)); },
            goToBottom: () => undefined, releaseAutoFollow: () => undefined, isPinned: false, showScrollButton: false,
        });
        return null;
    };
    const frames = async (n = 10) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
    try {
        await act(async () => root.render(React.createElement(Harness)));
        // Positions arrive: the list (and its scroller) is mounted anew.
        scrollRef.current = newNode as unknown as HTMLDivElement; scrollNode = newNode;
        await act(async () => root.render(React.createElement(Harness)));
        act(() => { void controller.loadEarlier({ userInitiated: true }); });
        await frames(2);
        anchor = { messageId: 'm100', offsetTop: 480 }; // The reader scrolls on the NEW scroller.
        newNode.fire('wheel'); newNode.fire('scroll');
        await frames(2);
        release();
        await frames(10);
        expect(holds).toEqual([[{ messageId: 'm100', offsetTop: 480 }, PREPEND_ANCHOR_HOLD]]);
        expect(oldNode.listeners.get('scroll')?.size ?? 0).toBe(0); // Nothing left on the detached element.
    } finally { await act(async () => root.unmount()); dom.restore(); }
});
