import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Provider } from '@opencode-ai/sdk/v2';
import { buildOrdinaryModelOptions, effectiveOrdinaryState } from './ordinaryModelOptions';
import { OrdinaryModelControls } from './OrdinaryModelControls';
import type { OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import { readFileSync } from 'node:fs';
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

// smarty-code#122 on 3.54: GPT-6 Astra was chosen and applied (the session reported it), but the listing still said Claude
// Opus 5.5; choosing Low then sent Opus with Low and undid the switch. The controls show, and build the next change from,
// the session's newer report.
describe('ordinary model controls follow the applied switch', () => {
  const opus = { providerID: 'cliproxyapi-anthropic', modelID: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const astra = { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' };
  const listed: OrdinaryModelState = { generation: 'g1', sequence: 10, thinkingLevel: 'high', model: opus };
  test('a newer applied report wins over the lagging listing', () => {
    const applied: OrdinaryModelState = { generation: 'g1', sequence: 11, thinkingLevel: 'high', model: astra };
    expect(effectiveOrdinaryState(listed, applied).model?.modelID).toBe('gpt-6-astra');
  });
  test('counterexample: once the listing catches up (or moves past), it wins; another generation never takes the report', () => {
    const applied: OrdinaryModelState = { generation: 'g1', sequence: 11, thinkingLevel: 'high', model: astra };
    expect(effectiveOrdinaryState({ ...listed, sequence: 11, model: astra }, applied).sequence).toBe(11);
    expect(effectiveOrdinaryState({ ...listed, sequence: 12, thinkingLevel: 'low' }, applied).thinkingLevel).toBe('low');
    expect(effectiveOrdinaryState({ ...listed, generation: 'g2' }, applied).model?.modelID).toBe('claude-opus-5-5');
  });
  test('the effort change is built from the shown (effective) model, not the listed one', () => {
    const src = readFileSync(new URL('./OrdinaryModelControls.tsx', import.meta.url), 'utf8');
    expect(src).toContain('const state = effectiveOrdinaryState(listed, applied);');
    expect(src).toContain('setApplied(await opencodeClient.setOrdinaryModel(');
    expect(src).toContain('const current = state.model;');
  });
});
