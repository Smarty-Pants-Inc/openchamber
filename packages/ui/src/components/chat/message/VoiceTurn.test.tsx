import { expect, test } from 'bun:test';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { getNormalizedMessageForDisplay } from '../lib/messageDisplayNormalization';
import { projectTurnRecords as projectRaw } from '../lib/turns/projectTurnRecords';
import { assembleRenderEntries, buildStaticRenderEntries, buildTrailingUngroupedEntry } from '../lib/turns/renderEntries';
import type { ChatMessageEntry } from '../lib/turns/types';
import { VoiceTurn } from './VoiceTurn';
import { HumanAuthor } from '@/components/auth/HumanAuthor';
import { isVoiceTurn, voiceSpeaker } from './voiceTurnData';

// The gateway's projection of a smarty-voice-turn entry (smarty-code#538, code-voice 46c89c994): a plain assistant
// record in its turn, told apart only by metadata.smartyVoice.speaker. The list normalizes every message first.
const projectTurnRecords = (messages: ChatMessageEntry[]) => projectRaw(messages.map(getNormalizedMessageForDisplay));
const voice = (id: string, speaker: string, text: string, parentID: string) => ({
  info: { id, sessionID: 's', role: 'assistant', agent: speaker === 'user' ? 'You said' : 'Voice said', parentID, time: { created: 1, completed: 1 },
    providerID: 'smarty-voice', modelID: 'voice', finish: 'stop', metadata: { smartyVoice: { speaker } } },
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text }],
}) as unknown as ChatMessageEntry;
const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const user = (id: string, text = 'hi') => ({ info: { id, sessionID: 's', role: 'user', time: { created: 1 } },
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text }] }) as unknown as ChatMessageEntry;
const reply = (id: string, parentID: string) => ({ info: { id, sessionID: 's', role: 'assistant', parentID, time: { created: 1, completed: 1 }, finish: 'stop' },
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text: 'done' }] }) as unknown as ChatMessageEntry;

// The same assembly MessageList passes to the list: every turn but the last is static; the last is the live row.
const rows = (raw: ChatMessageEntry[], hasOlderHistory = false) => {
  const messages = raw.map(getNormalizedMessageForDisplay);
  const projection = projectRaw(messages, { showLeadingOrphans: hasOlderHistory });
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

test('a "You said" that repeats its turn\'s request is hidden; different words, or a "Voice said", still show', () => {
  const request = user('u1', 'check the build');
  expect(rows([request, voice('v1', 'user', ' check the build ', 'u1'), reply('a1', 'u1')])).toEqual(['turn:u1']);
  expect(rows([request, voice('v1', 'user', 'and the tests', 'u1')])).toEqual(['turn:u1', 'v1']);
  expect(rows([request, voice('v1', 'voice', 'check the build', 'u1')])).toEqual(['turn:u1', 'v1']);
});

test('without the speaker metadata an assistant record stays a normal reply', () => {
  const plain = reply('a1', 'u1');
  expect(rows([user('u1'), plain])).toEqual(['turn:u1']);
  expect(isVoiceTurn(plain.info)).toBe(false);
});

test('a voice line before the first user turn (synthetic root parent) is a row, paged to the start or not', () => {
  const first = voice('v0', 'voice', 'Hi Paul, the call is open.', 'root-s');
  for (const older of [false, true]) {
    expect(rows([first], older)).toEqual(['v0']);
    expect(rows([first, voice('v1', 'user', 'status please', 'root-s'), user('u1'), reply('a1', 'u1')], older)).toEqual(['v0', 'v1', 'turn:u1']);
  }
  // Control: an ordinary leading orphan reply still hides once pagination reaches the start.
  expect(rows([reply('a0', 'root-s'), user('u1')], false)).toEqual(['turn:u1']);
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

test('a voice delegation reads "You said" above its request (metadata.smartyVoice.request); other requests do not', () => {
  const request = (metadata: unknown) => ({ id: 'u1', role: 'user', metadata });
  const said = render(<HumanAuthor info={request({ smartyVoice: { request: true } })} />);
  expect(said).toContain('You said');
  expect(said).toContain('data-voice-request');
  expect(HumanAuthor({ info: request({}) })).toBeNull();
  expect(HumanAuthor({ info: request({ smartyVoice: { request: 'yes' } }) })).toBeNull();
  const author = { version: 1, issuer: 'https://code.example.test', subject: 'p1', name: 'Paul' };
  const both = render(<HumanAuthor info={request({ smartyVoice: { request: true }, smartyCodeHuman: author })} />);
  expect(both).toContain('You said');
  expect(both).toContain('Paul');
});

test('the decided layout: You said (the request), the agent turn, then Voice said; the repeated voice line is merged', () => {
  const request = { ...user('u1', 'check the build'), info: { ...user('u1').info, metadata: { smartyVoice: { request: true } } } } as unknown as ChatMessageEntry;
  const journal = [request, voice('v1', 'user', 'check the build', 'u1'), reply('a1', 'u1'), voice('v2', 'voice', 'The build is green.', 'u1')];
  expect(rows(journal)).toEqual(['turn:u1', 'v2']);
});
