import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { ChatMessageEntry } from '../lib/turns/types';
import { useTurnRecords, type TurnRecordsResult } from './useTurnRecords';

// Just enough DOM for react-dom/client to mount a component that renders nothing.
const installMinimalDom = () => {
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const set = (name: string, value: unknown) => {
        saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const doc: Record<string, unknown> = { nodeType: 9, defaultView: globalThis, activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined };
    const container = { nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc, addEventListener: () => undefined, removeEventListener: () => undefined };
    doc.documentElement = container; doc.body = container;
    set('document', doc); set('window', globalThis); set('Element', ElementStub); set('HTMLElement', ElementStub);
    set('HTMLIFrameElement', ElementStub); set('IS_REACT_ACT_ENVIRONMENT', true);
    set('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    return {
        container: container as unknown as Element,
        restore: () => { for (const [name, d] of saved) { if (d) Object.defineProperty(globalThis, name, d); else Reflect.deleteProperty(globalThis, name); } },
    };
};

const entry = (id: string, role: 'user' | 'assistant', parentID?: string): ChatMessageEntry => ({
    info: { id, role, sessionID: 'ses_warm', ...(parentID ? { parentID } : {}), time: { created: 1 } } as Message, parts: [] as Part[],
});

// smarty-code#583 (openchamber#358 review round 2): a reply shown as its own row keeps that row after a remount that
// reuses the module-wide projection cache, when its prompt is then prepended by older history.
test('a warm-cache reopen remembers the shown reply rows, so a prepended prompt does not take msg:a0 away', async () => {
    const dom = installMinimalDom();
    try {
        const a0 = entry('a0', 'assistant', 'u0'), u1 = entry('u1', 'user'), a1 = entry('a1', 'assistant', 'u1');
        const shown = [a0, u1, a1];
        const options = { sessionKey: 'ses_warm', showTextJustificationActivity: false, showTurnChangedFiles: false, planModeEnabled: false, showLeadingOrphans: true };
        let latest: TurnRecordsResult | null = null;
        const Harness = ({ messages }: { messages: ChatMessageEntry[] }) => { latest = useTurnRecords(messages, options); return null; };

        const first = createRoot(dom.container);
        await act(async () => first.render(React.createElement(Harness, { messages: shown })));
        expect(latest!.projection.ungroupedMessageIds.has('a0')).toBe(true);
        await act(async () => first.unmount());

        // The reopen: a new hook instance, the same message objects, so the cached projection answers.
        const second = createRoot(dom.container);
        await act(async () => second.render(React.createElement(Harness, { messages: shown })));
        expect(latest!.projection.ungroupedMessageIds.has('a0')).toBe(true);

        // Older history arrives with a0's prompt: a0 stays its own row (msg:a0), it does not join turn:u0.
        await act(async () => second.render(React.createElement(Harness, { messages: [entry('u0', 'user'), ...shown] })));
        expect(latest!.projection.ungroupedMessageIds.has('a0')).toBe(true);
        await act(async () => second.unmount());
    } finally {
        dom.restore();
    }
});
