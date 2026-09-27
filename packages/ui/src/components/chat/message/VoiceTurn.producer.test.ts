import { expect, test } from 'bun:test';
import { getNormalizedMessageForDisplay } from '../lib/messageDisplayNormalization';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { assembleRenderEntries, buildStaticRenderEntries, buildTrailingUngroupedEntry } from '../lib/turns/renderEntries';
import type { ChatMessageEntry } from '../lib/turns/types';
import { findLastCompletedAssistantMessageID } from '@/lib/btw';
import { lastAssistantModel } from '@/sync/session-actions';
import { isVoiceRequest, isVoiceTurn } from './voiceTurnData';
import { voice568Records } from './voice568.fixture';

// review/astra on OC#302: test against the CURRENT producer's records (smarty-code#568 dfdc00839), not invented ones.
const records = voice568Records as unknown as ChatMessageEntry[];
const short = (id: string) => id.slice(0, 8);

/** The rows MessageList renders: static turns, the live last turn, ungrouped rows in journal order. */
const rows = (raw: ChatMessageEntry[], hasOlderHistory = false) => {
  const messages = raw.map(getNormalizedMessageForDisplay);
  const projection = projectTurnRecords(messages, { showLeadingOrphans: hasOlderHistory });
  const last = projection.turns[projection.turns.length - 1];
  const trailing = last ? { kind: 'turn' as const, key: `turn:${last.turnId}`, turn: last, isLastTurn: true }
    : buildTrailingUngroupedEntry(messages, projection.ungroupedMessageIds);
  const history = buildStaticRenderEntries(projection.turns.slice(0, -1), projection.lastTurnId, messages, projection.ungroupedMessageIds);
  const entries = assembleRenderEntries(history, trailing, messages);
  const replies = projection.turns.flatMap((turn) => turn.assistantMessageIds);
  return { order: entries.map((e) => (e.kind === 'turn' ? `T${short(e.turn.turnId)}` : short(e.message.info.id))), replies };
};

const realReplies = (raw: ChatMessageEntry[]) =>
  raw.filter((m) => m.info.role === 'assistant' && !isVoiceTurn(m.info)).map((m) => m.info.id);

test('every ordinary assistant reply stays in its turn, and each voice line is its own row, in journal order', () => {
  const { order, replies } = rows(records);
  expect(replies.sort()).toEqual(realReplies(records).sort());
  expect(order).toEqual([
    'T42e4117b', 'ca586652', '9e7ceac6',
    'Tf51da19a', 'c9afc9ea', 'c9444906',
    'Tb8dbc003', 'd8f48ef5', // the greeting follows the typed turn it was spoken after
    'T24c7392f', '160a4318', '7cb5d6e8',
    'T4c427a7a', '19c41216', '2617bb45',
  ]);
});

test('each delegated request is one user turn marked "You said"; the gateway sends no duplicate voice line', () => {
  const requests = records.filter((m) => m.info.role === 'user');
  expect(requests.filter((m) => isVoiceRequest(m.info)).map((m) => short(m.info.id))).toEqual(['42e4117b', 'f51da19a', '24c7392f', '4c427a7a']);
  expect(isVoiceRequest(requests.find((m) => short(m.info.id) === 'b8dbc003')!.info)).toBe(false); // typed, not spoken
  expect(records.filter((m) => isVoiceTurn(m.info) && (m.info as { metadata?: { smartyVoice?: { speaker?: string } } })
    .metadata?.smartyVoice?.speaker === 'user')).toEqual([]);
});

// The gateway's other two shapes (voice-log.ts at #568 dfdc00839), built as projectVoiceLine/projectVoiceStart build them.
const sid = records[0]!.info.sessionID;
const part = (id: string, text: string) => [{ id: `${id}-p`, sessionID: sid, messageID: id, type: 'text', text }];
/** An unpaired "You said" line: a user record, no parent; the replies that follow are parented on it. */
const youSaid = (id: string, created: number, text: string) => ({ info: { id, sessionID: sid, role: 'user', time: { created },
  agent: 'You said', model: { providerID: 'smarty-voice', modelID: 'voice' }, metadata: { smartyVoice: { speaker: 'user' } } },
  parts: part(id, text) }) as unknown as ChatMessageEntry;
const voiceSaid = (id: string, created: number, parentID: string, text: string) => ({ info: { id, sessionID: sid, role: 'assistant',
  parentID, time: { created, completed: created }, providerID: 'smarty-voice', modelID: 'voice', agent: 'Voice said', finish: 'stop',
  metadata: { smartyVoice: { speaker: 'voice' } } }, parts: part(id, text) }) as unknown as ChatMessageEntry;
const nativeReply = (id: string, created: number, parentID: string, text: string) => ({ info: { id, sessionID: sid, role: 'assistant',
  parentID, time: { created, completed: created + 1 }, providerID: 'cliproxyapi-anthropic', modelID: 'claude-opus-5-5', finish: 'stop' },
  parts: part(id, text) }) as unknown as ChatMessageEntry;

test('review P1: a spoken "You said" line anchors a turn: its real replies stay attached and it reads "You said"', () => {
  // During the agent's turn for request 24c7392f the person says more; the gateway parents what follows on that line.
  const at = records.findIndex((m) => short(m.info.id) === '7cb5d6e8');
  const line = youSaid('hv000001', 1790504250000, 'and check the disk too');
  const answer = nativeReply('hr000001', 1790504251000, 'hv000001', 'The disk is 40% full.');
  const spoken = voiceSaid('hs000001', 1790504253000, 'hv000001', 'The disk is under half full.');
  const journal = [...records.slice(0, at), line, answer, spoken, ...records.slice(at)];
  const projection = projectTurnRecords(journal.map(getNormalizedMessageForDisplay));
  const turn = projection.turns.find((t) => t.turnId === 'hv000001');
  expect(turn?.assistantMessageIds).toEqual(['hr000001']); // the real reply stays in the line's turn
  const { order, replies } = rows(journal);
  expect(replies.sort()).toEqual(realReplies(journal).sort());
  expect(order.slice(order.indexOf('T24c7392f'), order.indexOf('T4c427a7a')))
    .toEqual(['T24c7392f', '160a4318', 'Thv000001', 'hs000001', '7cb5d6e8']);
  expect(isVoiceTurn(line.info)).toBe(false);
  expect(isVoiceRequest(line.info)).toBe(false);
});

test('first conversation: a greeting before any request hangs on the gateway\'s voice-start turn, which keeps its replies', () => {
  const start = { info: { id: 'vs000001', sessionID: sid, role: 'user', time: { created: 1 }, agent: 'Voice call',
    model: { providerID: 'smarty-voice', modelID: 'voice' }, metadata: { smartyVoice: { start: true } } },
    parts: part('vs000001', 'Voice call') } as unknown as ChatMessageEntry;
  const journal = [start, voiceSaid('vg000001', 2, 'vs000001', 'Hi! What can I do?'), youSaid('hv000002', 3, 'what is running'),
    nativeReply('hr000002', 4, 'hv000002', 'Nothing of mine.'), voiceSaid('hs000002', 5, 'hv000002', 'Nothing of mine is running.')];
  for (const older of [false, true]) {
    const { order, replies } = rows(journal, older);
    expect(order).toEqual(['Tvs000001', 'vg000001', 'Thv000002', 'hs000002']);
    expect(replies).toEqual(['hr000002']);
  }
});

test('paged: a page that starts inside the history keeps its replies and voice rows; the first conversation too', () => {
  const tail = records.slice(records.findIndex((m) => short(m.info.id) === 'a1b7a191')); // starts after the typed request
  const paged = rows(tail, true);
  expect(paged.order).toEqual(['a1b7a191', 'd8f48ef5', 'T24c7392f', '160a4318', '7cb5d6e8', 'T4c427a7a', '19c41216', '2617bb45']);
  const firstCall = records.slice(0, records.findIndex((m) => short(m.info.id) === 'f51da19a'));
  const first = rows(firstCall, false);
  expect(first.order).toEqual(['T42e4117b', 'ca586652', '9e7ceac6']);
  expect(first.replies.sort()).toEqual(realReplies(firstCall).sort());
});

test('utility calls never pick a voice line: the model lookup and the /btw fork point skip it', () => {
  // The newest record is a "Voice said" line (provider smarty-voice); the real agent model is behind it.
  expect((records[records.length - 1]!.info as { providerID?: string }).providerID).toBe('smarty-voice');
  const model = lastAssistantModel(records.map((m) => m.info));
  expect(model?.providerID).not.toBe('smarty-voice');
  expect(model).toEqual(lastAssistantModel(records.filter((m) => !isVoiceTurn(m.info)).map((m) => m.info)));
  const fork = findLastCompletedAssistantMessageID(records.map((m) => m.info) as never);
  expect(fork && isVoiceTurn(records.find((m) => m.info.id === fork)!.info)).toBe(false);
});
