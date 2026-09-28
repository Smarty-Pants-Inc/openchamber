import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { projectTurnRecords, rememberShownOrphans } from './projectTurnRecords';
import { assembleRenderEntries, buildStaticRenderEntries, buildTrailingUngroupedEntry, insertGaps } from './renderEntries';
import { gapsOf } from '@/sync/position-windows';
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

// smarty-code#583 (continuous scroll-back jumped on 3.45): the rows a reader sees must keep their list keys when an older
// page brings their turn's user message, or the list loses its anchor and the view jumps.
describe('an older page arriving under the reader (smarty-code#583)', () => {
    const keysOf = (messages: ChatMessageEntry[], hasOlderHistory: boolean, kept: Set<string>) => {
        const projection = projectTurnRecords(messages, { showLeadingOrphans: hasOlderHistory, ...(kept.size ? { keepUngroupedAssistantIds: new Set(kept) } : {}) });
        rememberShownOrphans(messages, projection, kept);
        const rows = assembleRenderEntries(
            buildStaticRenderEntries(projection.turns, projection.lastTurnId, messages, projection.ungroupedMessageIds),
            buildTrailingUngroupedEntry(messages, projection.ungroupedMessageIds),
        );
        const rendered = rows.flatMap((row) => row.kind === 'turn' ? row.turn.messages.map((m) => m.messageId) : [row.message.info.id]);
        return { keys: rows.map((row) => row.key), rendered };
    };

    test('replies shown as their own rows keep their keys when their user message loads', () => {
        const kept = new Set<string>();
        const replies = [entry('a0', 'assistant', 'u0'), entry('a0b', 'assistant', 'u0'), entry('u1', 'user'), entry('a1', 'assistant', 'u1')];
        expect(keysOf(replies, true, kept).keys).toEqual(['msg:a0', 'msg:a0b', 'turn:u1']);
        // The older page lands: u0 and the turn above it.
        const { keys, rendered } = keysOf([entry('um', 'user'), entry('am', 'assistant', 'um'), entry('u0', 'user'), ...replies], false, kept);
        expect(keys).toEqual(['turn:um', 'turn:u0', 'msg:a0', 'msg:a0b', 'turn:u1']);
        // Every message once, in journal order.
        expect(rendered).toEqual(['um', 'am', 'u0', 'a0', 'a0b', 'u1', 'a1']);
    });

    test('a session opened fresh (nothing shown yet) still groups a turn\'s replies under it', () => {
        const kept = new Set<string>();
        expect(keysOf([entry('u0', 'user'), entry('a0', 'assistant', 'u0')], false, kept).keys).toEqual(['turn:u0']);
    });
});

// smarty-code#583: the list as long as the whole session.
describe('gap rows for the unloaded parts of a session (smarty-code#583)', () => {
    const positions = new Map<string, number>();
    const at = (id: string, position: number) => { positions.set(id, position); return id; };
    const messages = [entry(at('u10', 10), 'user'), entry(at('a11', 11), 'assistant', 'u10'), entry(at('u500', 500), 'user'), entry(at('a501', 501), 'assistant', 'u500')];
    const rows = () => {
        const projection = projectTurnRecords(messages, { showLeadingOrphans: true });
        return assembleRenderEntries(buildStaticRenderEntries(projection.turns, projection.lastTurnId, messages, projection.ungroupedMessageIds),
            buildTrailingUngroupedEntry(messages, projection.ungroupedMessageIds));
    };

    test('each gap sits where its records belong, at its estimated height; gaps after the last row are left to the live tail', () => {
        const listed = insertGaps(rows(), gapsOf([{ start: 10, end: 12 }, { start: 500, end: 502 }], 600), (id) => positions.get(id), 100);
        // A long gap is several rows of at most 100 records each (a single row millions of px tall left the list blank).
        expect(listed.map((row) => row.key)).toEqual(['gap:0', 'turn:u10', 'gap:12', 'gap:112', 'gap:212', 'gap:312', 'gap:412', 'turn:u500']);
        expect(listed.filter((row) => row.kind === 'gap').map((row) => (row as { heightPx: number }).heightPx)).toEqual([1_000, 10_000, 10_000, 10_000, 10_000, 8_800]);
    });

    test('a window whose rows are all hidden still shows the gaps before its end (a blank list on the candidate)', () => {
        const listed = insertGaps([], gapsOf([{ start: 250, end: 300 }], 400), () => undefined, 100, 300);
        expect(listed.map((row) => row.key)).toEqual(['gap:0', 'gap:100', 'gap:200']);
    });

    test('without gaps the rows are unchanged', () => {
        const all = rows();
        expect(insertGaps(all, [], (id) => positions.get(id), 100)).toBe(all);
    });
});
