import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { ChatMessageEntry } from '../lib/turns/types';
import { VoiceTurn } from './VoiceTurn';
import { FabricMessageRow } from './FabricMessageRow';
import { fabricMessageOf } from './fabricMessageData';

// smarty-code#739, on org's real 3:53 AM turns: one turn, one message; Fabric messages as their own rows.
const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const entry = (id: string, role: string, text: string, metadata?: unknown) => ({
  info: { id, sessionID: 's', role, time: { created: 1, completed: 1 }, ...(metadata ? { metadata } : {}) },
  parts: [{ id: `${id}-p`, sessionID: 's', messageID: id, type: 'text', text }],
}) as unknown as ChatMessageEntry;
const spoken = (id: string, text: string, extra: Record<string, unknown> = {}) => entry(id, 'assistant', text, { smartyVoice: { speaker: 'voice', ...extra } });
const written = entry('a1', 'assistant', 'Checked, Paul, and everything looks good: the proxy is running from the new location.');
const youSaid = entry('u2', 'user', 'Thank you', { smartyVoice: { speaker: 'user' } });

test('a spoken reading of the written reply is one collapsed "spoken" line under it, not a second message', () => {
  const html = render(<VoiceTurn message={spoken('v1', "Checked, Paul, and everything looks good. Sleep well.")} previousMessage={written} />);
  expect(html).toContain('spoken');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Sleep well.'); // collapsed: one click shows it
  expect(html).not.toContain('Voice said');
});

test('the gateway\'s turn mark attaches the line to its reply even when another row sits between', () => {
  expect(render(<VoiceTurn message={spoken('v1', 'Sleep well.', { turn: 'a1' })} previousMessage={youSaid} />)).toContain('aria-expanded="false"');
});

test('a spoken line that differs from the text opens by itself, flagged', () => {
  const html = render(<VoiceTurn message={spoken('v1', 'Nothing is left for you tonight.', { differs: true })} previousMessage={written} />);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('differs from the text');
  expect(html).toContain('Nothing is left for you tonight.');
  expect(html).toContain('--status-warning');
});

test('filler is never shown', () => {
  expect(render(<VoiceTurn message={spoken('v0', 'Let me check that.', { filler: true })} previousMessage={written} />)).toBe('');
});

test('a voice-only reply (no written reply before it) is the reply: its words in one plain line', () => {
  const html = render(<VoiceTurn message={spoken('v2', "You're welcome.")} previousMessage={youSaid} />);
  expect(html).toContain("You&#x27;re welcome.");
  expect(html).not.toContain('aria-expanded');
  expect(html).not.toContain('>Voice said<');
});

test('a Fabric message needs the gateway\'s envelope sender; message text is never evidence', () => {
  expect(fabricMessageOf({ role: 'user' })).toBeUndefined();
  expect(fabricMessageOf({ metadata: { smartyFabric: { from: '  ' } } })).toBeUndefined();
  expect(fabricMessageOf({ metadata: { smartyFabric: { from: 'org (Paul)', to: 'org-kate', ref: 'smarty-dev#1578' } } }))
    .toEqual({ from: 'org (Paul)', to: 'org-kate', ref: 'smarty-dev#1578', text: undefined });
});

test('a Fabric message is a collapsed row with its real sender; one click shows the text', () => {
  const html = render(<FabricMessageRow fabric={{ from: 'dev-lead', to: 'org', ref: 'smarty-code#359' }}><p>agreed, no read-App private key</p></FabricMessageRow>);
  expect(html).toContain('data-fabric-message="true"');
  expect(html).toContain('Message from');
  expect(html).toContain('dev-lead');
  expect(html).toContain('smarty-code#359');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('agreed, no read-App private key');
});

test('the chat renders a Fabric user message as the row, before the person\'s bubble', () => {
  const source = readFileSync(new URL('../ChatMessage.tsx', import.meta.url), 'utf8');
  expect(/\{isUser && fabric \? \(\s*(\/\/[^\n]*\n\s*)?<FabricMessageRow fabric=\{fabric\}>/.test(source)).toBe(true);
  expect(source).toContain('const fabric = isUser ? fabricMessageOf(message.info) : undefined;');
});
