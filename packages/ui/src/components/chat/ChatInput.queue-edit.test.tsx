import { afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { deferred, directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore } from '@/stores/messageQueueStore';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent, switchRuntimeEndpoint } from '@/lib/runtime-switch';

// The shared fixture omits queue chips for draft-only tests. Keep the actual
// component here and restore that leaf, without changing the draft-owned fixture.
const actualChips = (await import('./QueuedMessageChips')).QueuedMessageChips;
const { mountedNativeComposer, errors } = await import('./composer/submit/__tests__/nativeComposer.fixture');
const chips = await import('./QueuedMessageChips');
const renderActualChips = Object.assign(
    (props: React.ComponentProps<typeof actualChips>) => React.createElement(actualChips, props),
    actualChips,
);
spyOn(chips, 'QueuedMessageChips').mockImplementation(renderActualChips);

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
const initialQueue = useMessageQueueStore.getState();
afterEach(async () => {
    await mounted?.dispose(); mounted = undefined;
    useMessageQueueStore.setState(initialQueue, true);
});

for (const navigation of ['session', 'generation', 'runtime', 'typing', 'none'] as const) test(`mounted Edit receipt retains origin custody without stale publication: ${navigation}`, async () => {
    const c = mounted = await mountedNativeComposer(false);
    const owner = createMessageQueueTarget(session.id, directory, c.runtimeA);
    if (!owner) throw new Error('Missing queue owner');
    const item = { id: 'edit-queued', state: 'pending' as const, createdAt: 1, content: 'old queued text', text: 'old queued text',
        attachments: [{ id: 'old-attachment', filename: 'old.txt', mimeType: 'text/plain', size: 3, source: 'local' as const, dataUrl: 'data:text/plain;base64,b2xk' }],
        context: [{ kind: 'synthetic' as const, text: 'old queued context' }], sendConfig: { providerID: 'p', modelID: 'm' } };
    await act(async () => {
        useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: directory,
            newSessionDraft: { ...state.newSessionDraft, open: false } }));
        useMessageQueueStore.setState({ queuedMessages: {}, recoveryMessages: {}, sendingIds: {} });
        useMessageQueueStore.getState().applyServerSession({ sessionId: session.id, directory, sendingId: null, items: [item] }, 1, c.runtimeA);
    });
    await c.replace('input before Edit');
    const held = deferred<Response>();
    const otherFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith('/items/edit-queued/take')) { requests.push(request); return held.promise; }
        return otherFetch(input, init);
    };
    await act(async () => {
        const edit = Array.from(c.dom.container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'edit');
        if (!edit) throw new Error('Actual queue Edit button missing');
        edit.click(); await sleep(0);
    });
    expect(requests).toHaveLength(1);
    if (navigation === 'generation') {
        const scope = captureRuntimeRequestScope();
        // Same URL/key/session/input, but a different transport generation.
        // No editor change can incidentally satisfy the publication fence.
        await act(async () => { switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: c.runtimeA }); });
        expect(isRuntimeRequestScopeCurrent(scope)).toBe(false);
    } else if (navigation !== 'none') {
        await act(async () => {
            if (navigation === 'session') useSessionUIStore.setState({ currentSessionId: 'other-session', currentSessionDirectory: directory });
            if (navigation === 'runtime') c.switchRuntime('other-queue-runtime');
        });
        await c.replace('new editor text');
        await act(async () => {
            useInputStore.setState({ attachedFiles: [], pendingSyntheticParts: [{ text: 'new context', synthetic: true }] });
        });
    }
    const before = useInputStore.getState();
    const inlineBefore = useInlineCommentDraftStore.getState();
    await act(async () => {
        held.resolve(Response.json({ revision: 2, item, session: { sessionId: session.id, directory, sendingId: null,
            items: [{ ...item, state: 'taken' }] } }));
        await sleep(0);
    });
    expect(errors).toEqual([]); // The accepted take is not reported as rejection.
    if (navigation === 'none') {
        expect(c.text()).toBe('old queued text');
        expect(useInputStore.getState().attachedFiles.map(file => file.id)).toContain('old-attachment');
    } else {
        expect(c.text()).toBe(navigation === 'generation' ? 'input before Edit' : 'new editor text');
        expect(useInputStore.getState()).toBe(before);
        expect(useInlineCommentDraftStore.getState()).toBe(inlineBefore);
    }
    expect(getRuntimeKey()).toBe(navigation === 'runtime' ? 'other-queue-runtime' : c.runtimeA);
    const retained = useMessageQueueStore.getState().recoveryMessages[getMessageQueueKey(owner)].find(message => message.id === item.id);
    expect(retained?.state).toBe('taken');
    expect(retained?.attachments?.[0].dataUrl).toBe(item.attachments[0].dataUrl);
    expect(retained?.context).toEqual(item.context);
    expect(requests).toHaveLength(1);
    expect(c.prompts()).toHaveLength(0);
});
