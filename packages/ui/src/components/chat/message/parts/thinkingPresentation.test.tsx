import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Part } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import AssistantTextPart from './AssistantTextPart';
import ReasoningPart from './ReasoningPart';
import type { StreamPhase } from '../types';

// smarty-code#3140: session thinking must be distinguishable from the reply,
// both in the inline preference and the collapsible/grouped Activity path.
const reasoning: Extract<Part, { type: 'reasoning' }> = {
  id: 'thinking-3140', sessionID: 'session-3140', messageID: 'message-3140',
  type: 'reasoning', text: 'I will check the session renderer.\nThen verify the reply stays unchanged.',
  time: { start: 1_000 },
};
const reply: Extract<Part, { type: 'text' }> = {
  ...reasoning, id: 'reply-3140', type: 'text', text: 'The session renderer is fixed.',
};
const render = (element: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
const THINKING_STYLE = 'text-muted-foreground italic';

for (const phase of ['streaming', 'cooldown', 'completed'] satisfies StreamPhase[]) {
  describe(`thinking presentation during ${phase}`, () => {
    const part = phase === 'completed' ? { ...reasoning, time: { start: 1_000, end: 2_000 } } : reasoning;

    test('inline thinking has a small text label and muted italic body', () => {
      const markup = render(<AssistantTextPart part={part} messageId={part.messageID} streamPhase={phase} />);
      expect(markup).toContain('Thinking');
      expect(markup).toContain('typography-meta');
      expect(markup).toContain(THINKING_STYLE);
    });

    test('collapsible thinking retains its label and shows the styled body by default', () => {
      const markup = render(<ReasoningPart part={part} messageId={part.messageID} streamPhase={phase} />);
      expect(markup).toContain('Thinking');
      expect(markup).toContain('typography-meta');
      expect(markup).toContain('aria-expanded="true"');
      expect(markup).toContain('aria-hidden="false"');
      expect(markup).toContain(THINKING_STYLE);
    });

    test('reply text does not get a Thinking label or thinking styles', () => {
      const markup = render(<AssistantTextPart part={reply} messageId={reply.messageID} streamPhase={phase} />);
      expect(markup).not.toContain('Thinking');
      expect(markup).not.toContain('text-muted-foreground');
      expect(markup).not.toContain('italic');
    });
  });
}

test('reloaded reasoning without timing or live phase stays visible without a busy indicator', () => {
  const markup = render(<ReasoningPart part={reasoning} messageId={reasoning.messageID} />);
  expect(markup).toContain('Thinking');
  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain(THINKING_STYLE);
  expect(markup).not.toContain('animate-busy-pulse');
});
