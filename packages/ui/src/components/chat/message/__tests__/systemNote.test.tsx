import { expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStore } from 'zustand/vanilla';
import type { Message, Part } from '@opencode-ai/sdk/v2';

// A store the notice reads, standing in for SyncProvider's directory store (no network).
const directoryStore = createStore<{ message: Record<string, Message[]> }>(() => ({ message: {} }));
let sessionStatus: { type: string } | undefined = { type: 'idle' };
mock.module('@/sync/sync-context', () => ({
  useDirectoryStore: () => directoryStore,
  useSessionStatus: () => sessionStatus,
}));

const { projectTurnRecords } = await import('../../lib/turns/projectTurnRecords');
const { assembleRenderEntries, buildStaticRenderEntries, buildTrailingUngroupedEntry } = await import('../../lib/turns/renderEntries');
const { SystemNoteLine } = await import('../SystemNoteLine');
const { isSystemNoteMessage } = await import('../systemNote');
const { SessionErrorNotice } = await import('../../SessionErrorNotice');
const { I18nProvider } = await import('@/lib/i18n');
type Entry = import('../../lib/turns/types').ChatMessageEntry;

// The gateway's projection of smarty-voice bd10f169 'smarty-voice-state' notes (smarty-code gateway voiceStateNote).
const note = (id: string, text: string, created: number, parentID = 'ask'): Entry => ({
  info: { id, sessionID: 's', role: 'assistant', clientRole: 'system-note', nativeRole: 'custom', parentID,
    time: { created, completed: created }, metadata: { smartyNote: { customType: 'smarty-voice-state' } } } as unknown as Message,
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text } as unknown as Part],
});
const user = (id: string, created: number): Entry => ({ info: { id, sessionID: 's', role: 'user', time: { created } } as Message,
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text: 'hello' } as unknown as Part] });
const reply = (id: string, created: number, completed?: number): Entry => ({
  info: { id, sessionID: 's', role: 'assistant', parentID: 'ask', time: { created, ...(completed ? { completed } : {}) } } as unknown as Message,
  parts: [] });
const rows = (messages: Entry[]) => {
  const projection = projectTurnRecords(messages, {});
  return { projection, rows: assembleRenderEntries(
    buildStaticRenderEntries(projection.turns, projection.lastTurnId, messages, projection.ungroupedMessageIds),
    buildTrailingUngroupedEntry(messages, projection.ungroupedMessageIds)) };
};

test('a call start and end show as two system lines in order, outside the turn, with their times', () => {
  const now = Date.now();
  const messages = [user('ask', now), note('start', 'Voice call started (reason: attached page).', now + 1),
    reply('reply', now + 2, now + 3), note('end', 'Voice call ended (reason: stopped by the attached page), after 42 s.', now + 4)];
  const { projection, rows: list } = rows(messages);
  // The turn is the ask and its reply only; the notes are not the agent's messages.
  expect(projection.turns.map(t => [t.userMessageId, t.assistantMessageIds])).toEqual([['ask', ['reply']]]);
  expect(list.map(r => r.kind === 'turn' ? `turn:${r.turn.turnId}` : `line:${r.message.info.id}`)).toEqual(['turn:ask', 'line:start', 'line:end']);
  const html = list.flatMap(r => r.kind === 'ungrouped' && isSystemNoteMessage(r.message.info)
    ? [renderToStaticMarkup(<SystemNoteLine message={r.message} />)] : []);
  expect(html).toHaveLength(2);
  expect(html[0]).toContain('role="note"');
  expect(html[0]).toContain('Voice call started (reason: attached page).');
  expect(html[1]).toContain('Voice call ended (reason: stopped by the attached page), after 42 s.');
  for (const line of html) expect(/tabular-nums[^>]*>[^<]+</.test(line)).toBe(true); // Each line carries its time.
});

test('a streaming reply keeps its turn working after a call note arrives (Stop stays available)', () => {
  const now = Date.now();
  const { projection } = rows([user('ask', now), reply('reply', now + 1), note('end', 'Voice call ended (reason: error: x), after 3 s.', now + 2)]);
  expect(projection.turns[0]!.assistantMessageIds).toEqual(['reply']);
  expect(projection.turns[0]!.stream.isStreaming).toBe(true);
});

const notice = (messages: Entry[]) => {
  directoryStore.setState({ message: { s: messages.map(m => m.info) } });
  return renderToStaticMarkup(<I18nProvider><SessionErrorNotice sessionId="s" /></I18nProvider>);
};

test("a call note never answers the person: an unanswered ask still shows 'did not start a reply'", () => {
  sessionStatus = { type: 'idle' };
  const earlier = Date.now() - 10_000;
  const withNote = notice([user('ask', earlier), note('start', 'Voice call started (reason: attached page).', earlier + 1)]);
  const plain = notice([user('ask', earlier)]);
  expect(plain).toContain('role="status"');
  expect(withNote).toBe(plain);
});

test('a call note after a real reply adds no notice', () => {
  sessionStatus = { type: 'idle' };
  const earlier = Date.now() - 10_000;
  expect(notice([user('ask', earlier), reply('reply', earlier + 1, earlier + 2),
    note('end', 'Voice call ended (reason: stopped by the attached page), after 42 s.', earlier + 3)])).toBe('');
});
