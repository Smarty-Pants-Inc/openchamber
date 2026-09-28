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

test('an exact repeat of the written reply (matched) is one collapsed "spoken" line, not a second message', () => {
  const html = render(<VoiceTurn message={spoken('v1', 'Checked, Paul, and everything looks good.', { matched: true, turn: 'a1' })} />);
  expect(html).toContain('spoken');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('everything looks good'); // collapsed: one click shows it
  expect(html).not.toContain('Voice said');
});

test('a spoken line that is not a repeat shows in full, as the reply', () => {
  const html = render(<VoiceTurn message={spoken('v2', "You're welcome.")} />);
  expect(html).toContain("You&#x27;re welcome.");
  expect(html).not.toContain('aria-expanded');
  expect(html).not.toContain('>Voice said<');
});

test('replies the voice was given and did not say sit beside the line, collapsed and amber', () => {
  const html = render(<VoiceTurn message={spoken('v3', 'Everything is done.', { relayed: ['The deploy key still needs your approval.', ' ', 7] })} />);
  expect(html).toContain('Everything is done.');
  expect(html).toContain('Not said (1)');
  expect(html).toContain('--status-warning');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('The deploy key still needs your approval.');
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
