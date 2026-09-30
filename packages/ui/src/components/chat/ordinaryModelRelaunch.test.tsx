import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import { I18nProvider } from '@/lib/i18n';
import { OrdinaryModelControls } from './OrdinaryModelControls';

// smarty-code#778 (code-demo on 3.59): /reload of an open fleet session. The gateway reports `reloading` ~0.3 s after
// /reload and `connected` 0.5-2.4 s later; the session's model is back up to ~1 s after `connected`. Meanwhile the listing
// has no model, and the composer read "Unavailable" for 1-2 s. It keeps the last model (read-only) or shows Loading.
const sol = { providerID: 'cliproxyapi', modelID: 'gpt-6-1-sol', name: 'GPT-6.1 Sol' };
const withModel = (generation: string): OrdinaryModelState => ({ generation, sequence: 1, thinkingLevel: 'medium', model: sol });
const noModel: OrdinaryModelState = { generation: null, sequence: 0, thinkingLevel: null, model: null };

function mount() {
  const win = new Window({ url: 'http://localhost' });
  Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true });
  // happy-dom is now the global document, so the DOM typings apply without an assertion.
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (state: OrdinaryModelState, reloading: boolean) => act(async () => {
    root.render(<I18nProvider><OrdinaryModelControls state={state} reloading={reloading} /></I18nProvider>);
  });
  return { render, text: () => host.textContent ?? '', unmount: () => act(async () => { root.unmount(); }) };
}

test('a relaunch keeps the last model, never Unavailable; the fresh model follows', async () => {
  const view = mount();
  await view.render(withModel('g1'), false);
  expect(view.text()).toContain('GPT-6.1 Sol');
  await view.render(withModel('g1'), true); // `reloading`, model still listed
  await view.render(noModel, true); // the relaunch drops the model
  expect(view.text()).toContain('GPT-6.1 Sol');
  expect(view.text()).not.toContain('Unavailable');
  await view.render(noModel, false); // `connected`, model not back yet (up to ~1 s)
  expect(view.text()).toContain('GPT-6.1 Sol');
  expect(view.text()).not.toContain('Unavailable');
  await view.render({ ...withModel('g2'), model: { ...sol, name: 'GPT-6.1 Sol (new)' } }, false);
  expect(view.text()).toContain('GPT-6.1 Sol (new)');
  await view.unmount();
});

test('no last model while reloading: Loading, not Unavailable', async () => {
  const view = mount();
  await view.render(noModel, true);
  expect(view.text()).toContain('Loading');
  expect(view.text()).not.toContain('Unavailable');
  await view.unmount();
});

test('counterexample: not reloading and no model is Unavailable, also once the 3 s relaunch grace ends', async () => {
  const view = mount();
  await view.render(noModel, false);
  expect(view.text()).toContain('Unavailable');
  await view.render(withModel('g1'), true);
  await view.render(noModel, false);
  expect(view.text()).toContain('GPT-6.1 Sol');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
  expect(view.text()).toContain('Unavailable');
  await view.unmount();
});
