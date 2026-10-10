import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, TextPart, ToolPart, UserMessage } from '@opencode-ai/sdk/v2';
import { projectTurnRecords } from './projectTurnRecords';
import { assembleRenderEntries, buildStaticRenderEntries, buildTrailingUngroupedEntry, insertGaps } from './renderEntries';
import type { ChatMessageEntry } from './types';

const textPart = (messageID: string, text: string): TextPart => ({
    id: `${messageID}-text`, sessionID: 's', messageID, type: 'text', text,
});
const assistantInfo = (id: string, parentID: string): AssistantMessage => ({
    id, sessionID: 's', role: 'assistant', parentID, time: { created: 1, completed: 2 },
    modelID: 'm', providerID: 'p', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
const reply = (id: string, parentID = 'unloaded', tool = false): ChatMessageEntry => {
    const part: ToolPart = {
        id: `${id}-tool`, sessionID: 's', messageID: id, type: 'tool', callID: `${id}-call`, tool: 'bash',
        state: { status: 'completed', input: { command: 'pwd' }, output: '/', title: 'pwd', metadata: {}, time: { start: 1, end: 2 } },
    };
    return { info: assistantInfo(id, parentID), parts: tool ? [part] : [textPart(id, 'Loaded answer')] };
};
const note = (id = 'note', parentID = 'unloaded'): ChatMessageEntry => {
    const info: AssistantMessage & { clientRole: 'system-note'; nativeRole: 'custom' } = {
        ...assistantInfo(id, parentID), clientRole: 'system-note', nativeRole: 'custom',
    };
    return { info, parts: [textPart(id, 'Voice call started.')] };
};
const user = (id: string): ChatMessageEntry => {
    const info: UserMessage = {
        id, sessionID: 's', role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' },
    };
    return { info, parts: [textPart(id, 'Prompt')] };
};
const system = (): ChatMessageEntry => {
    const info: AssistantMessage & { clientRole: 'system' } = { ...assistantInfo('system', 'unloaded'), clientRole: 'system' };
    return { info, parts: [] };
};

// Actual MessageList projection and static/trailing assembly, with no previously kept orphan IDs to rescue replies.
const assemble = (messages: ChatMessageEntry[], options: Parameters<typeof projectTurnRecords>[1] = {}) => {
    const projection = projectTurnRecords(messages, options);
    const rows = assembleRenderEntries(
        buildStaticRenderEntries(projection.turns, projection.lastTurnId, messages, projection.ungroupedMessageIds),
        buildTrailingUngroupedEntry(messages, projection.ungroupedMessageIds),
        messages,
    );
    const rendered = rows.flatMap(row => row.kind === 'turn' ? row.turn.messages.map(record => record.message) : [row.message]);
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
    expect(new Set(rendered.map(message => message.info.id)).size).toBe(rendered.length);
    for (const row of rows) {
        if (row.kind === 'turn') expect(row.turn.messages.some(record => record.role === 'system-note')).toBe(false);
    }
    return { projection, rows, rendered };
};
const expectContent = (rendered: ChatMessageEntry[], messages: ChatMessageEntry[]) => {
    expect(rendered).toEqual(messages);
    messages.forEach((message, index) => {
        expect(rendered[index]).toBe(message);
        expect(rendered[index]?.parts).toBe(message.parts);
    });
};
const leadingReplies = (placement: 'before' | 'between', parentID = 'unloaded') => {
    const text = reply('text', parentID);
    const tool = reply('tool', parentID, true);
    const line = note('note', parentID);
    return placement === 'before' ? [line, text, tool] : [text, line, tool];
};

describe('system notes at loaded-history boundaries', () => {
    for (const placement of ['before', 'between'] as const) {
        test(`older history keeps text/tool replies with a note ${placement} them`, () => {
            const messages = leadingReplies(placement);
            const { rows, rendered, projection } = assemble(messages, { showLeadingOrphans: true });
            expect(rows.map(row => row.key)).toEqual(messages.map(message => `msg:${message.info.id}`));
            expectContent(rendered, messages);
            expect(projection.turns).toEqual([]);
        });

        for (const loadedParent of [false, true]) {
            test(`a gap window with a note ${placement} replies keeps content, parent ${loadedParent ? 'in older segment' : 'unloaded'}`, () => {
                const older = [user('older'), reply('older-reply', 'older')];
                const window = leadingReplies(placement, loadedParent ? 'older' : 'unloaded');
                const messages = [...older, ...window];
                const { rows, rendered, projection } = assemble(messages, {
                    showLeadingOrphans: false, windowStartIds: new Set([window[0]!.info.id]),
                });
                const positions = new Map(messages.map((message, index) => [message.info.id, index < 2 ? index : index + 8]));
                const timeline = insertGaps(rows, [{ start: 2, end: 10, key: 'unloaded-gap' }], id => positions.get(id), 100, 13);
                expect(timeline.map(row => row.key)).toEqual(['turn:older', 'gap:2', ...window.map(message => `msg:${message.info.id}`)]);
                expectContent(rendered, messages);
                expect(projection.turns[0]?.assistantMessageIds).toEqual(['older-reply']);
            });
        }

        test(`a note ${placement} replies does not enable orphan display by default`, () => {
            const messages = leadingReplies(placement);
            const { rows, rendered } = assemble(messages);
            expect(rows.map(row => row.key)).toEqual(['msg:note']);
            expectContent(rendered, messages.filter(message => message.info.id === 'note'));
        });
    }

    test('a real user ends leading display; notes remain outside turns and later orphans stay hidden', () => {
        const first = reply('leading');
        const prompt = user('prompt');
        const line = note('note', 'prompt');
        const answer = reply('answer', 'prompt');
        const { rows, rendered, projection } = assemble([first, prompt, line, answer, reply('late')], { showLeadingOrphans: true });
        expect(rows.map(row => row.key)).toEqual(['msg:leading', 'turn:prompt', 'msg:note']);
        expectContent(rendered, [first, prompt, answer, line]);
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['answer']);
    });

    test('a real system boundary still ends leading display, even with a following note', () => {
        const first = reply('leading');
        const boundary = system();
        const line = note();
        const { rows, rendered } = assemble([first, boundary, line, reply('late')], { showLeadingOrphans: true });
        expect(rows.map(row => row.key)).toEqual(['msg:leading', 'msg:system', 'msg:note']);
        expectContent(rendered, [first, boundary, line]);
    });
});
