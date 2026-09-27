import { expect, test } from 'bun:test';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { assembleRenderEntries, buildStaticRenderEntries, buildTrailingUngroupedEntry } from '../lib/turns/renderEntries';
import type { ChatMessageEntry } from '../lib/turns/types';
import { VoiceTurn } from './VoiceTurn';
import { isVoiceTurn, voiceSpeaker } from './voiceTurnData';

// The gateway's projection of a smarty-voice-turn entry (smarty-code#538, agreed with code-voice).
const voice = (id: string, speaker: string, text: string, parentID: string) => ({
  info: { id, sessionID: 's', role: 'assistant', clientRole: 'voice-turn', parentID, time: { created: 1, completed: 1 },
    providerID: 'smarty-voice', modelID: 'voice', finish: 'stop', metadata: { smartyVoice: { speaker } } },
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text }],
}) as unknown as ChatMessageEntry;
const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const user = (id: string) => ({ info: { id, sessionID: 's', role: 'user', time: { created: 1 } },
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text: 'hi' }] }) as unknown as ChatMessageEntry;
const reply = (id: string, parentID: string) => ({ info: { id, sessionID: 's', role: 'assistant', parentID, time: { created: 1, completed: 1 }, finish: 'stop' },
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text: 'done' }] }) as unknown as ChatMessageEntry;

// The same assembly MessageList passes to the list: every turn but the last is static; the last is the live row.
const rows = (messages: ChatMessageEntry[]) => {
  const projection = projectTurnRecords(messages);
  const last = projection.turns[projection.turns.length - 1];
  const trailing = last ? { kind: 'turn' as const, key: `turn:${last.turnId}`, turn: last, isLastTurn: true }
    : buildTrailingUngroupedEntry(messages, projection.ungroupedMessageIds);
  const history = buildStaticRenderEntries(projection.turns.slice(0, -1), projection.lastTurnId, messages, projection.ungroupedMessageIds);
  return assembleRenderEntries(history, trailing, messages).map(e => e.kind === 'turn' ? `turn:${e.turn.turnId}` : e.message.info.id);
};

test('voice rows keep journal order after the live turn, and do not move when the next prompt arrives (review/astra OC#299)', () => {
  const journal = [user('u1'), reply('a1', 'u1'), voice('v1', 'user', 'check the build', 'u1'), voice('v2', 'voice', 'It is green.', 'u1')];
  expect(rows(journal)).toEqual(['turn:u1', 'v1', 'v2']);
  expect(projectTurnRecords(journal).turns[0]!.assistantMessageIds).toEqual(['a1']);
  expect(rows([...journal, user('u2'), reply('a2', 'u2')])).toEqual(['turn:u1', 'v1', 'v2', 'turn:u2']);
});

test('a voice row before a later turn stays before it, interleaved with the normal turns', () => {
  const journal = [user('u1'), reply('a1', 'u1'), voice('v1', 'user', 'next', 'u1'), user('u2'), reply('a2', 'u2'), voice('v2', 'voice', 'done', 'u2')];
  expect(rows(journal)).toEqual(['turn:u1', 'v1', 'turn:u2', 'v2']);
  expect(rows([...journal, user('u3')])).toEqual(['turn:u1', 'v1', 'turn:u2', 'v2', 'turn:u3']);
});

test('labels follow the speaker: You said, Voice said', () => {
  expect(isVoiceTurn(voice('v', 'user', 'x', 'u').info)).toBe(true);
  expect(isVoiceTurn(reply('a', 'u').info)).toBe(false);
  expect(voiceSpeaker({ metadata: { smartyVoice: { speaker: 'bogus' } } })).toBe('voice');
  const you = render(<VoiceTurn message={voice('v1', 'user', 'check the build', 'u1')} />);
  expect(you).toContain('You said');
  expect(you).toContain('check the build');
  expect(render(<VoiceTurn message={voice('v2', 'voice', 'It is green.', 'u1')} />)).toContain('Voice said');
  expect(render(<VoiceTurn message={voice('v4', 'voice', '  ', 'u1')} />)).toBe('');
});
