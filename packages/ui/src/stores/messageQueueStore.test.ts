import { beforeEach, describe, expect, test } from 'bun:test';
import { createMessageQueueTarget, getMessageQueueKey, migrateMessageQueueState, parseMessageQueueKey, useMessageQueueStore } from './messageQueueStore';

beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {}, recoveryMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
});

const target = (runtimeKey = 'runtime-a') => {
    const value = createMessageQueueTarget('session-1', '/repo', runtimeKey);
    if (!value) throw new Error('Missing test queue target');
    return value;
};
const message = (id: string) => ({ id, content: id, text: id, createdAt: 1 });

describe('message queue ownership and legacy recovery', () => {
    test('isolates equal session IDs by runtime and directory', () => {
        const a = target();
        const b = target('runtime-b');
        useMessageQueueStore.setState({ queuedMessages: { [getMessageQueueKey(a)]: [message('a')], [getMessageQueueKey(b)]: [message('b')] } });
        expect(useMessageQueueStore.getState().getQueueForTarget(a)[0].content).toBe('a');
        expect(useMessageQueueStore.getState().getQueueForTarget(b)[0].content).toBe('b');
    });

    test('round trips a composite queue key', () => {
        expect(parseMessageQueueKey(getMessageQueueKey(target()))).toEqual(target());
    });

    test('quarantines unscoped legacy queues without claiming another runtime', () => {
        const migrated = migrateMessageQueueState({ queuedMessages: { 'session-1': [message('legacy')] } }, 1);
        expect(migrated.queuedMessages).toEqual({});
        expect(migrated.quarantinedLegacyMessages?.['session-1'][0].content).toBe('legacy');
    });

    test('scoped legacy messages keep their text for review, never automatic delivery', () => {
        const key = getMessageQueueKey(target());
        const migrated = migrateMessageQueueState({ queuedMessages: { [key]: [{ id: 'old', content: '@Builder old', createdAt: 1 }] } }, 2);
        expect(migrated.queuedMessages).toEqual({});
        expect(migrated.recoveryMessages?.[key][0]).toMatchObject({ text: '@Builder old', state: 'unconfirmed' });
    });
});

describe('foreground attempt settlement', () => {
    test('a failed local attempt stays recoverable, but is no longer sendable', () => {
        const owner = target();
        const key = getMessageQueueKey(owner);
        useMessageQueueStore.setState({ queuedMessages: { [key]: [message('first'), message('second')] } });
        const store = useMessageQueueStore.getState();
        store.markSending(owner, 'first');
        expect(store.getSendableQueue(owner).map(item => item.id)).toEqual(['second']);
        store.clearSending(owner, 'first');
        expect(store.getSendableQueue(owner).map(item => item.id)).toEqual(['second']);
        expect(useMessageQueueStore.getState().recoveryMessages[key][0]).toMatchObject({ id: 'first', state: 'unknown' });
        expect(useMessageQueueStore.getState().sendingIds).toEqual({});
    });

    test('an in-flight item remains visible but is not sendable', () => {
        const owner = target();
        const key = getMessageQueueKey(owner);
        useMessageQueueStore.setState({ queuedMessages: { [key]: [message('first'), message('second')] } });
        // This is the local transition contract; avoid an unrelated server request.
        useMessageQueueStore.getState().markSending(owner, 'first');
        expect(useMessageQueueStore.getState().getSendableQueue(owner).map(item => item.id)).toEqual(['second']);
        expect(useMessageQueueStore.getState().getQueueForTarget(owner)).toHaveLength(2);
    });
});
