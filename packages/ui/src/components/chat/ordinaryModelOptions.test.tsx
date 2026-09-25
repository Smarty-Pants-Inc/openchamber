import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Provider } from '@opencode-ai/sdk/v2';
import { buildOrdinaryModelOptions } from './ordinaryModelOptions';
import { OrdinaryModelControls } from './OrdinaryModelControls';
import { I18nProvider } from '@/lib/i18n';

type Model = Provider['models'][string];
// SAFETY: the option builder reads only id and name from a catalog model.
const model = (id: string, name: string) => ({ id, name }) as Model;

// smarty-code#126 F7 (a): the picker shows the model name, not "cliproxyapi-anthropic  Claude Opus 5.5".
describe('ordinary model picker labels', () => {
  test('a unique model name is shown alone', () => {
    const options = buildOrdinaryModelOptions([
      { id: 'cliproxyapi-anthropic', models: [model('claude-opus-5-5', 'Claude Opus 5.5')] },
      { id: 'cliproxyapi', models: [model('gpt-6-astra', 'GPT 6 Astra')] },
    ]);
    expect(options.map(option => option.label)).toEqual(['Claude Opus 5.5', 'GPT 6 Astra']);
  });

  test('the provider joins the label only when two providers share a model name', () => {
    const options = buildOrdinaryModelOptions([
      { id: 'anthropic', models: [model('opus', 'Claude Opus 5.5'), model('haiku', 'Claude Haiku')] },
      { id: 'cliproxyapi-anthropic', models: [model('claude-opus-5-5', 'Claude Opus 5.5')] },
    ]);
    expect(options.map(option => option.label)).toEqual([
      'anthropic / Claude Opus 5.5', 'Claude Haiku', 'cliproxyapi-anthropic / Claude Opus 5.5',
    ]);
  });

  test('the control shows the model name; the provider is only in the title', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OrdinaryModelControls state={{ generation: 'g1', sequence: 1, thinkingLevel: 'high',
          model: { providerID: 'cliproxyapi-anthropic', modelID: 'claude-opus-5-5', name: 'Claude Opus 5.5' } }} />
      </I18nProvider>,
    );
    expect(html).toContain('>Claude Opus 5.5</span>');
    expect(html).toContain('title="cliproxyapi-anthropic / claude-opus-5-5"');
    expect(html).not.toContain('>cliproxyapi-anthropic</span>');
  });
});
