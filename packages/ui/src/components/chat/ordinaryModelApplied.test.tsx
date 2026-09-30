import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import { useAppliedOrdinaryState } from './ordinaryModelOptions';

// openchamber#419 review 1: after a recorded switch, an unavailable listing leaves no usable model; the recorded switch is
// dropped, so a later usable listing (a lower sequence after the restart) is shown as listed, not the old switch.
const opus = { providerID: 'cliproxyapi-anthropic', modelID: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
const astra = { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' };
test('a recorded switch, then an unavailable listing: no usable model survives, now or after it recovers', async () => {
  const win = new Window({ url: 'http://localhost' });
  Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true });
  let shown: OrdinaryModelState | undefined, record: ((s: OrdinaryModelState) => void) | undefined;
  function Probe({ listed }: { listed: OrdinaryModelState }) { const [s, set] = useAppliedOrdinaryState(listed); shown = s; record = set; return null; }
  const root = createRoot(win.document.createElement('div') as unknown as HTMLElement);
  const render = (listed: OrdinaryModelState) => act(async () => { root.render(<Probe listed={listed} />); });
  await render({ generation: 'g1', sequence: 10, thinkingLevel: 'high', model: opus });
  await act(async () => { record!({ generation: 'g1', sequence: 11, thinkingLevel: 'high', model: astra }); });
  expect(shown?.model?.modelID).toBe('gpt-6-astra'); // The switch shows while the listing lags.
  await render({ generation: 'g1', sequence: 0, thinkingLevel: null, model: null });
  expect(shown?.model).toBeNull(); // Unavailable: the controls show "Unavailable", no picker.
  await render({ generation: 'g1', sequence: 3, thinkingLevel: 'low', model: opus });
  expect(shown?.model?.modelID).toBe('claude-opus-5-5'); // The old switch never resurfaces.
  await act(async () => { root.unmount(); });
});
