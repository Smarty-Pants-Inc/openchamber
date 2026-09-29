import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import {
    HISTORY_RENDER_WAIT_TIMEOUT_MS,
    isOlderHistoryPrependCommit,
    shouldAutoLoadEarlierForUnderfilledPinnedViewport,
    useChatTimelineController,
    type UseChatTimelineControllerResult,
} from './useChatTimelineController';
import type { MessageListHandle } from '../MessageList';

const baseInput = {
    sessionId: 'ses_1',
    isPinned: true,
    canLoadEarlier: true,
    isLoadingOlder: false,
    pendingRevealWork: false,
    scrollHeight: 799,
    clientHeight: 800,
};

describe('shouldAutoLoadEarlierForUnderfilledPinnedViewport', () => {
    test('loads when pinned content does not fill the viewport', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport(baseInput)).toBe(true);
    });

    test('does not load when content already overflows', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            scrollHeight: 802,
        })).toBe(false);
    });

    test('does not load while user is away from bottom or history work is active', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            isPinned: false,
        })).toBe(false);
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            isLoadingOlder: true,
        })).toBe(false);
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            pendingRevealWork: true,
        })).toBe(false);
    });
});

describe('isOlderHistoryPrependCommit', () => {
    test('detects older messages inserted above the existing timeline', () => {
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_1',
            currentNewestId: 'msg_4',
        })).toBe(true);
    });

    test('does not treat appends or replacements as prepends', () => {
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_2',
            currentNewestId: 'msg_5',
        })).toBe(false);
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_1',
            currentNewestId: 'msg_5',
        })).toBe(false);
    });
});

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((next) => {
        resolve = next;
    });
    return { promise, resolve };
};

const installMinimalDom = () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = (name: string, value: unknown) => {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const documentStub: Record<string, unknown> = {
        nodeType: 9,
        defaultView: globalThis,
        activeElement: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const container = {
        nodeType: 1,
        tagName: 'DIV',
        nodeName: 'DIV',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: documentStub,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    documentStub.documentElement = container;
    documentStub.body = container;
    setGlobal('document', documentStub);
    setGlobal('window', globalThis);
    setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
    setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    return {
        container: container as unknown as Element,
        restore: () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

/**
 * The controller's render waiters, observed and held (smarty-code#674): each waiter arms a HISTORY_RENDER_WAIT_TIMEOUT_MS
 * fallback timer. `waiting(n)` resolves once n waiters exist; a fallback never fires by itself, only by `fire(n)`, so a
 * waiter leaves by the render commit or by the fallback the test fires, never by wall-clock time. The test used to wait
 * out the 250 ms and assume one microtask; a slow machine (CI run 36337222540 attempt 2, 322 ms) raced it. Other timers
 * run as usual.
 */
const observeRenderWaiters = () => {
    const original = globalThis.setTimeout;
    let armed = 0;
    const callbacks: Array<() => void> = [];
    const watchers: Array<{ n: number; resolve: () => void }> = [];
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms !== HISTORY_RENDER_WAIT_TIMEOUT_MS) return original(callback, ms, ...args);
        armed += 1;
        callbacks.push(() => callback(...args));
        for (const w of watchers.filter((x) => x.n <= armed)) { watchers.splice(watchers.indexOf(w), 1); w.resolve(); }
        const held = original(callback, 2 ** 31 - 1, ...args);
        (held as { unref?: () => void }).unref?.();
        return held;
    }) as typeof setTimeout;
    // Frames too: after B's page grows the timeline, the controller chains the next page from a frame (smarty-code#583).
    // In this minimal DOM a frame is setTimeout(0), which raced the test's final reads (a third load, 3 of 60 runs).
    const frame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
    return {
        waiting: (n: number) => armed >= n ? Promise.resolve() : new Promise<void>((resolve) => { watchers.push({ n, resolve }); }),
        /** The nth waiter's fallback, fired now (a no-op for a waiter its commit already released). */
        fire: (n: number) => callbacks[n - 1]?.(),
        restore: () => { globalThis.setTimeout = original; globalThis.requestAnimationFrame = frame; },
    };
};

describe('useChatTimelineController identity lifecycle', () => {
    test('preserves the new identity while an old load is waiting for its render', async () => {
        const dom = installMinimalDom();
        const renderWaiters = observeRenderWaiters();
        const root: Root = createRoot(dom.container);
        const pendingA = deferred();
        const pendingB = deferred();
        const calls: string[] = [];
        const sessionId = 'shared-session';
        const message = {
            info: { id: 'msg_1', sessionID: sessionId, role: 'user', time: { created: 1 } } as Message,
            parts: [],
        };
        const olderMessage = {
            info: { id: 'msg_0', sessionID: sessionId, role: 'user', time: { created: 0 } } as Message,
            parts: [],
        };
        const assistantMessage = {
            info: { id: 'msg_2', sessionID: sessionId, role: 'assistant', time: { created: 2 } } as Message,
            parts: [],
        };
        const scrollMetrics = {
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            firstElementChild: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        };
        const scrollElement = scrollMetrics as unknown as HTMLDivElement;
        const scrollRef = { current: scrollElement };
        const capturedAnchors: string[] = [];
        const restoredAnchors: string[] = [];
        const messageListRef = {
            current: {
                captureViewportAnchor: () => {
                    const messageId = `anchor-${directory}`;
                    capturedAnchors.push(messageId);
                    return { messageId, offsetTop: 0 };
                },
                restoreViewportAnchor: (anchor: { messageId: string }) => {
                    restoredAnchors.push(anchor.messageId);
                    return true;
                },
                isHistoryVirtualized: () => false,
                scrollToTurnId: () => false,
                scrollToMessageId: () => false,
            } as unknown as MessageListHandle,
        };
        let controller!: UseChatTimelineControllerResult;
        let directory = 'A';
        let messages = [message];
        let startBOnLayout = false;
        let loadB: Promise<void> | null = null;

        const Harness = () => {
            const selectedDirectory = directory;
            controller = useChatTimelineController({
                sessionId,
                sessionKey: `runtime\n${selectedDirectory}\n${sessionId}`,
                messages,
                historyMeta: { limit: 1, complete: false, loading: false },
                scrollRef,
                messageListRef,
                loadMoreMessages: async () => {
                    calls.push(selectedDirectory);
                    await (selectedDirectory === 'A' ? pendingA.promise : pendingB.promise);
                },
                goToBottom: () => undefined,
                releaseAutoFollow: () => undefined,
                isPinned: false,
                showScrollButton: false,
            });
            React.useLayoutEffect(() => {
                if (selectedDirectory === 'B' && startBOnLayout && !loadB) {
                    loadB = controller.loadEarlier({ userInitiated: true });
                }
            }, [selectedDirectory]);
            return null;
        };

        try {
            await act(async () => root.render(React.createElement(Harness)));
            let loadA!: Promise<void>;
            act(() => {
                loadA = controller.loadEarlier({ userInitiated: true });
            });
            expect(calls).toEqual(['A']);

            // Let A pass its post-network identity check and enter the render
            // waiter before switching. B starts in the same layout commit that
            // releases A's waiter, so A must not clear B's new snapshot.
            await act(async () => {
                pendingA.resolve();
                await renderWaiters.waiting(1); // A is in its render waiter: the switch below is the commit that releases it.
            });
            directory = 'B';
            // Growth within the existing user turn means stale A would request
            // another A page after its render wait without the second token gate.
            messages = [message, assistantMessage];
            startBOnLayout = true;
            await act(async () => {
                root.render(React.createElement(Harness));
                // act holds this render until its callback ends, so A leaves its waiter by its fallback, as it did
                // after 250 ms of wall clock; the test fires it (smarty-code#674). B then starts in the switch commit.
                renderWaiters.fire(1);
                await loadA;
            });
            expect(calls).toEqual(['A', 'B']);
            expect(controller.isLoadingOlder).toBe(true);
            expect(capturedAnchors).toContain('anchor-B');
            expect(restoredAnchors).toEqual([]);

            await act(async () => {
                pendingB.resolve();
                await renderWaiters.waiting(2); // B is in its render waiter: the render below releases it.
            });
            messages = [olderMessage, message, assistantMessage];
            scrollMetrics.scrollHeight = 1200;
            act(() => {
                root.render(React.createElement(Harness));
            });
            await act(async () => {
                await loadB;
            });
            expect(controller.isLoadingOlder).toBe(false);
            expect(calls).toEqual(['A', 'B']);
            expect(restoredAnchors).toEqual(['anchor-B']);
        } finally {
            await act(async () => root.unmount());
            renderWaiters.restore();
            dom.restore();
        }
    });
});
