import { expect, test } from 'bun:test';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { buildStaticRenderEntries } from '../lib/turns/renderEntries';
import type { ChatMessageEntry } from '../lib/turns/types';
import { isVoiceTurn, VoiceTurn, voiceSpeaker } from './VoiceTurn';

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

test('voice turns are their own rows after the turn they fall in, in journal order, and never join or hide the agent reply', () => {
  const messages = [user('u1'), voice('v1', 'user', 'check the build', 'u1'), reply('a1', 'u1'), voice('v2', 'voice', 'It is green.', 'u1')];
  const projection = projectTurnRecords(messages);
  const entries = buildStaticRenderEntries(projection.turns, projection.lastTurnId, messages, projection.ungroupedMessageIds);
  expect(entries.map(e => e.kind === 'turn' ? `turn:${e.turn.turnId}` : e.message.info.id)).toEqual(['turn:u1', 'v1', 'v2']);
  expect(projection.turns[0]!.assistantMessageIds).toEqual(['a1']);
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
