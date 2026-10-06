import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { feedEntries } from './feedEntries';

// smarty-code#1407: the Feed shows the person's own messages and, for each assistant turn, only its final text.
const user = (id: string, created: number, parts: Part[]) => ({
  info: { id, sessionID: 's', role: 'user', time: { created }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } satisfies Message,
  parts,
});
const assistant = (id: string, parentID: string, created: number, parts: Part[], completed: number | null = created + 1) => ({
  info: { id, sessionID: 's', role: 'assistant', time: { created, completed: completed ?? undefined }, parentID, modelID: 'm', providerID: 'p', mode: 'build', agent: 'build',
    path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } satisfies Message,
  parts,
});
const text = (id: string, messageID: string, value: string, extra: { synthetic?: boolean } = {}): Part => ({ id, sessionID: 's', messageID, type: 'text', text: value, ...extra });
const tool = (id: string, messageID: string): Part => ({ id, sessionID: 's', messageID, type: 'tool', callID: id, tool: 'bash',
  state: { status: 'completed', input: {}, output: 'ok', title: 'ls', metadata: {}, time: { start: 1, end: 2 } } });
const file = (id: string, messageID: string, mime: string, filename: string): Part => ({ id, sessionID: 's', messageID, type: 'file', mime, filename, url: `data:${mime};base64,AA==` });
const reasoning = (id: string, messageID: string): Part => ({ id, sessionID: 's', messageID, type: 'reasoning', text: 'thinking hard', time: { start: 1 } });

describe('feedEntries', () => {
  test('a turn with tool calls and intermediate text shows only its final text; user messages show', () => {
    const records = [
      user('u1', 100, [text('u1t', 'u1', 'What is open for me today?'), text('u1s', 'u1', 'pinned project context', { synthetic: true })]),
      assistant('a1', 'u1', 110, [reasoning('a1r', 'a1'), text('a1t', 'a1', 'Let me check the inbox.'), tool('a1x', 'a1')]),
      assistant('a2', 'u1', 120, [text('a2t', 'a2', 'Looking at the PRs next.'), tool('a2x', 'a2'), text('a2f', 'a2', 'You have **two** reviews waiting.')]),
      user('u2', 200, [text('u2t', 'u2', 'Thanks!')]),
      assistant('a3', 'u2', 210, [text('a3t', 'a3', 'Any time.')]),
    ];
    // A user message keeps all its parts (the chat itself hides synthetic context); an answer keeps only its final text.
    expect(feedEntries(records).map(({ id, role, time, message }) => ({ id, role, time, parts: message.parts.map(part => part.id) }))).toEqual([
      { id: 'u1', role: 'user', time: 100, parts: ['u1t', 'u1s'] },
      { id: 'a2', role: 'assistant', time: 121, parts: ['a2f'] },
      { id: 'u2', role: 'user', time: 200, parts: ['u2t'] },
      { id: 'a3', role: 'assistant', time: 211, parts: ['a3t'] },
    ]);
    expect(feedEntries(records)[1]?.message.info).toBe(records[2]?.info);
  });

  test('a turn still working shows no assistant text yet: intermediate text before a tool call is not its answer', () => {
    const records = [
      user('u1', 100, [text('u1t', 'u1', 'Deploy it')]),
      assistant('a1', 'u1', 110, [text('a1t', 'a1', 'Starting the deploy.'), tool('a1x', 'a1')]),
      assistant('a2', 'u1', 120, [text('a2t', 'a2', 'Still streaming')], null),
    ];
    expect(feedEntries(records).map(e => e.id)).toEqual(['u1']);
  });

  test('the final message keeps its image and file parts; a user message keeps its attachments, even without text', () => {
    const records = [
      user('u1', 100, [file('u1f', 'u1', 'image/png', 'screen.png')]),
      assistant('a1', 'u1', 110, [text('a1t', 'a1', 'Rendering the chart.'), tool('a1x', 'a1'), file('a1o', 'a1', 'image/png', 'draft.png')]),
      assistant('a2', 'u1', 120, [reasoning('a2r', 'a2'), file('a2c', 'a2', 'image/png', 'chart.png'), text('a2t', 'a2', 'Here is the chart.'),
        file('a2d', 'a2', 'application/pdf', 'report.pdf')]),
    ];
    expect(feedEntries(records).map(({ id, message }) => ({ id, parts: message.parts.map(part => part.id) }))).toEqual([
      { id: 'u1', parts: ['u1f'] },
      { id: 'a2', parts: ['a2c', 'a2t', 'a2d'] },
    ]);
  });

  test('an agent-to-agent Fabric message is not the person\'s own', () => {
    const steer = user('u1', 100, [text('u1t', 'u1', 'Steer: check the deploy')]);
    const records = [{ ...steer, info: { ...steer.info, metadata: { smartyFabric: { from: 'org-paul' } } } }];
    expect(feedEntries(records)).toEqual([]);
  });

  test('a user message with only synthetic context is not shown', () => {
    const records = [user('u1', 100, [text('u1s', 'u1', 'system context', { synthetic: true })])];
    expect(feedEntries(records)).toEqual([]);
  });
});
