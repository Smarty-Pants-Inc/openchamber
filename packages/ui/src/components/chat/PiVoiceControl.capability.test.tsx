import React, { act } from 'react';
import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';

// The voice control must stay hidden unless the gateway advertises session voice for the
// session's directory: an OpenChamber build can ship before the gateway that serves the call.
type Voice = { available: boolean; reason?: string };
const advertised = new Map<string, Voice>();
const asked: string[] = [];
mock.module('@/lib/opencode/client', () => ({ opencodeClient: {
  sessionVoiceAvailability: async (sessionId: string, directory: string) => { asked.push(`${sessionId}@${directory}`); const voice = advertised.get(directory); if (!voice) throw new Error('health unreachable'); return voice; },
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
  const buttons = [...container.querySelectorAll('button')];
  names?.push(...buttons.map(button => button.getAttribute('aria-label') ?? ''));
  const shown = buttons.length === 0 ? 'hidden' : buttons[0].disabled ? `disabled: ${buttons[0].getAttribute('aria-label')}` : buttons[0].textContent;
  act(() => root.unmount());
  return shown;
}

// smarty-code#126: the call control is labelled as a call. A session without voice says why (the gateway's per-session
// reason, verbatim; a generic one when the status read failed) instead of hiding it. Unknown (health unreachable): hidden.
test('a labelled Voice call control, disabled with the session\'s own plain reason where it has no voice', async () => {
  const herdr = 'Voice calls work in sessions started from Code. This session was started in Herdr.';
  advertised.set('/with-voice', { available: true });
  advertised.set('/herdr', { available: false, reason: herdr });
  advertised.set('/status-failed', { available: false });
  expect(await render('/with-voice')).toBe('Voice call');
  expect(await render('/herdr')).toBe(`disabled: Voice call. ${herdr}`);
  expect(await render('/status-failed')).toBe('disabled: Voice call. Voice calls are not available in this session.');
  expect(await render('/unreachable')).toBe('hidden'); // unknown stays hidden
  expect(asked).toEqual(['s1@/with-voice', 's1@/herdr', 's1@/status-failed', 's1@/unreachable']);
});

test('hidden in VS Code without asking the gateway', async () => {
  asked.length = 0;
  expect(await render('/with-voice', true)).toBe('hidden');
  expect(asked).toEqual([]);
});

test('a call bound to another session offers Move call here, not a second start; its own session shows no control', async () => {
  const store = await import('@/lib/voice/piVoiceActiveCall');
  const { fakePiVoiceDriver } = await import('@/lib/voice/piVoiceTestDriver');
  advertised.set('/with-voice', { available: true });
  const { driver, runtime } = fakePiVoiceDriver();
  runtime.key = (await import('@/lib/runtime-switch')).getRuntimeKey(); // The page's runtime, as the control sees it.
  await store.startPiVoiceCallFor('org', '/with-voice', driver, { onEnded() {}, onFailed() {} });
  const elsewhere: string[] = [], own: string[] = [];
  expect(await render('/with-voice', false, 'lane', elsewhere)).toBe('Move call here');
  expect(elsewhere).toEqual(['Move call here']); // End is the call bar's, on every screen.
  expect(await render('/with-voice', false, 'org', own)).toBe('hidden');
  store.endActivePiVoiceCall();
});

test('a call on another runtime is never shown as this session’s call, even with the same session ID', async () => {
  const store = await import('@/lib/voice/piVoiceActiveCall');
  const { fakePiVoiceDriver } = await import('@/lib/voice/piVoiceTestDriver');
  advertised.set('/with-voice', { available: true });
  const { driver, runtime } = fakePiVoiceDriver();
  runtime.key = 'another-instance';
  await store.startPiVoiceCallFor('org', '/with-voice', driver, { onEnded() {}, onFailed() {} });
  expect(await render('/with-voice', false, 'org')).toBe('Move call here');
  store.endActivePiVoiceCall();
});

test('Move call here respects the target session: a session without voice shows its reason, not Move', async () => {
  const store = await import('@/lib/voice/piVoiceActiveCall');
  const { fakePiVoiceDriver } = await import('@/lib/voice/piVoiceTestDriver');
  const reason = 'Voice calls work in sessions started from Code. This session was started in Herdr.';
  advertised.set('/with-voice', { available: true });
  advertised.set('/herdr', { available: false, reason });
  const { driver, runtime } = fakePiVoiceDriver();
  runtime.key = (await import('@/lib/runtime-switch')).getRuntimeKey();
  await store.startPiVoiceCallFor('org', '/with-voice', driver, { onEnded() {}, onFailed() {} });
  expect(await render('/herdr', false, 'fleet-row')).toBe(`disabled: Voice call. ${reason}`);
  store.endActivePiVoiceCall();
});

test('ending a call from outside the control (the call bar) re-reads the session\'s voice status', async () => {
  const store = await import('@/lib/voice/piVoiceActiveCall');
  const { fakePiVoiceDriver } = await import('@/lib/voice/piVoiceTestDriver');
  advertised.set('/with-voice', { available: true });
  const { driver, runtime } = fakePiVoiceDriver();
  runtime.key = (await import('@/lib/runtime-switch')).getRuntimeKey();
  const happy = new Window({ url: 'https://code.example.test' });
  const values = { window: happy, document: happy.document, navigator: happy.navigator, Node: happy.Node,
    Element: happy.Element, HTMLElement: happy.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // SAFETY: PiVoiceControl reads only `runtime.isVSCode` from the runtime context.
  const runtimeApis = { runtime: { platform: 'web', isVSCode: false, isDesktop: false } } as RuntimeAPIs;
  await act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={runtimeApis}><PiVoiceControl sessionId="org" directory="/with-voice" /></RuntimeAPIContext.Provider></I18nProvider>);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  await act(async () => { await store.startPiVoiceCallFor('org', '/with-voice', driver, { onEnded() {}, onFailed() {} }); });
  asked.length = 0;
  advertised.set('/with-voice', { available: false, reason: 'This session is not connected right now.' });
  await act(async () => { store.endActivePiVoiceCall(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(asked).toEqual(['org@/with-voice']);
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Voice call. This session is not connected right now.');
  act(() => root.unmount());
});
