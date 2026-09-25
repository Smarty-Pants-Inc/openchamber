import React, { act } from 'react';
import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';

// The voice control must stay hidden unless the gateway advertises session voice for the
// session's directory: an OpenChamber build can ship before the gateway that serves the call.
const advertised = new Map<string, boolean>();
const asked: string[] = [];
mock.module('@/lib/opencode/client', () => ({ opencodeClient: {
  supportsSessionVoice: async (directory: string) => { asked.push(directory); return advertised.get(directory) === true; },
} }));
mock.module('@/lib/voice/piVoiceMedia', () => ({ supportsPiVoice: () => true, browserPiVoiceMedia: () => { throw new Error('not in this test'); } }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));

const { PiVoiceControl } = await import('./PiVoiceControl');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');

const NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
afterEach(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function render(directory: string, isVSCode = false, sessionId = 's1', names?: string[]) {
  const happy = new Window({ url: 'https://code.example.test' });
  const values = { window: happy, document: happy.document, navigator: happy.navigator, Node: happy.Node,
    Element: happy.Element, HTMLElement: happy.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // SAFETY: PiVoiceControl reads only `runtime.isVSCode` from the runtime context.
  const runtime = { runtime: { platform: 'web', isVSCode, isDesktop: false } } as RuntimeAPIs;
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={runtime}>
          <PiVoiceControl sessionId={sessionId} directory={directory} />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  const buttons = container.querySelectorAll('button').length;
  names?.push(...[...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? ''));
  act(() => root.unmount());
  return buttons;
}

test('hidden until the gateway advertises session voice for the directory', async () => {
  advertised.set('/with-voice', true);
  expect(await render('/without-voice')).toBe(0);
  expect(await render('/with-voice')).toBe(1);
  expect(asked).toEqual(['/without-voice', '/with-voice']);
});

test('hidden in VS Code without asking the gateway', async () => {
  asked.length = 0;
  advertised.set('/with-voice', true);
  expect(await render('/with-voice', true)).toBe(0);
  expect(asked).toEqual([]);
});

test('a call bound to another session shows Move call here and End, not a second start', async () => {
  const store = await import('@/lib/voice/piVoiceActiveCall');
  const { fakePiVoiceDriver } = await import('@/lib/voice/piVoiceTestDriver');
  advertised.set('/with-voice', true);
  const { driver, runtime } = fakePiVoiceDriver();
  runtime.key = (await import('@/lib/runtime-switch')).getRuntimeKey(); // The page's runtime, as the control sees it.
  await store.startPiVoiceCallFor('org', '/with-voice', driver, { onEnded() {}, onFailed() {} });
  const elsewhere: string[] = [], own: string[] = [];
  expect(await render('/with-voice', false, 'lane', elsewhere)).toBe(2);
  expect(elsewhere).toEqual(['Move call here', 'End voice call']);
  expect(await render('/with-voice', false, 'org', own)).toBe(1);
  expect(own).toEqual(['End voice call']);
  store.endActivePiVoiceCall();
});

test('a call on another runtime is never shown as this session’s call, even with the same session ID', async () => {
  const store = await import('@/lib/voice/piVoiceActiveCall');
  const { fakePiVoiceDriver } = await import('@/lib/voice/piVoiceTestDriver');
  advertised.set('/with-voice', true);
  const { driver, runtime } = fakePiVoiceDriver();
  runtime.key = 'another-instance';
  await store.startPiVoiceCallFor('org', '/with-voice', driver, { onEnded() {}, onFailed() {} });
  const names: string[] = [];
  expect(await render('/with-voice', false, 'org', names)).toBe(2);
  expect(names).toEqual(['Move call here', 'End voice call']);
  store.endActivePiVoiceCall();
});
