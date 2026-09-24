import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { projectTurnRecords } from './projectTurnRecords';
import { assembleRenderEntries, buildStaticRenderEntries, buildTrailingUngroupedEntry } from './renderEntries';
import type { ChatMessageEntry } from './types';

const entry = (id: string, role: 'user' | 'assistant', parentID?: string): ChatMessageEntry => ({
    info: { id, role, ...(parentID ? { parentID } : {}), time: { created: 1 } } as Message, parts: [] as Part[],
});

// The same assembly MessageList passes to LegendList (all turns static here; no streaming turn).
const listKeys = (messages: ChatMessageEntry[], hasOlderHistory: boolean) => {
    const projection = projectTurnRecords(messages, { showLeadingOrphans: hasOlderHistory });
    const rows = assembleRenderEntries(
        buildStaticRenderEntries(projection.turns, projection.lastTurnId, messages, projection.ungroupedMessageIds),
        buildTrailingUngroupedEntry(messages, projection.ungroupedMessageIds),
    );
    const rendered = rows.flatMap((row) => row.kind === 'turn' ? row.turn.messages.map((m) => m.messageId) : [row.message.info.id]);
    return { keys: rows.map((row) => row.key), rendered };
};

// review/astra on OC#163: an all-assistant first page put its last reply in two rows with the same list key.
describe('message list render entries', () => {
    test('an all-assistant page with older history renders each message once, with unique keys', () => {
        const { keys, rendered } = listKeys([entry('a0', 'assistant', 'u0'), entry('a0b', 'assistant', 'u0')], true);
        expect(keys).toEqual(['msg:a0', 'msg:a0b']);
        expect(new Set(keys).size).toBe(keys.length);
        expect(rendered).toEqual(['a0', 'a0b']);
    });

    test('when the user message loads, the leading replies regroup under its turn with no duplicate and no lost row', () => {
        const { keys, rendered } = listKeys([entry('u0', 'user'), entry('a0', 'assistant', 'u0'), entry('a0b', 'assistant', 'u0')], false);
        expect(keys).toEqual(['turn:u0']);
        expect(rendered.sort()).toEqual(['a0', 'a0b', 'u0']);
    });
});
