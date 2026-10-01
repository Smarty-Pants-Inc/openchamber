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
const pending = new Map<string, Promise<Voice>>();
mock.module('@/lib/opencode/client', () => ({ opencodeClient: {
  sessionVoiceAvailability: async (sessionId: string, directory: string) => { asked.push(`${sessionId}@${directory}`); const voice = pending.get(directory) ?? advertised.get(directory); if (!voice) throw new Error('health unreachable'); return voice; },
} }));
mock.module('@/lib/voice/piVoiceMedia', () => ({ supportsPiVoice: () => true, browserPiVoiceMedia: () => { throw new Error('not in this test'); } }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));

const NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'Event', 'MouseEvent', 'PointerEvent', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);

function createWindow() {
  const happy = new Window({ url: 'https://code.example.test' });
  const values = { window: happy, document: happy.document, navigator: happy.navigator, Node: happy.Node,
    Element: happy.Element, HTMLElement: happy.HTMLElement, DocumentFragment: happy.DocumentFragment,
    Event: happy.Event, MouseEvent: happy.MouseEvent, PointerEvent: happy.PointerEvent,
    getComputedStyle: happy.getComputedStyle.bind(happy), ResizeObserver: happy.ResizeObserver,
    requestAnimationFrame: happy.requestAnimationFrame.bind(happy), cancelAnimationFrame: happy.cancelAnimationFrame.bind(happy),
    IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  return happy;
}
// Base UI selects browser layout effects at import time. Use the real tooltip, not a mocked one.
createWindow();
const { PiVoiceControl } = await import('./PiVoiceControl');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  pending.clear();
  asked.length = 0;
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function mount(directory: string, isVSCode = false, sessionId = 's1') {
  const happy = createWindow();
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
  cleanup = () => act(() => root.unmount());
  return { container, happy, unmount: () => { cleanup(); cleanup = () => {}; },
    changeSession: async (nextSessionId: string, nextDirectory = directory) => {
      await act(async () => {
        root.render(<I18nProvider><RuntimeAPIContext.Provider value={runtime}><PiVoiceControl sessionId={nextSessionId} directory={nextDirectory} /></RuntimeAPIContext.Provider></I18nProvider>);
        await new Promise(resolve => setTimeout(resolve, 10));
      });
    },
  };
}

async function render(directory: string, isVSCode = false, sessionId = 's1', names?: string[]) {
  const mounted = await mount(directory, isVSCode, sessionId);
  const buttons = [...mounted.container.querySelectorAll('button')];
  names?.push(...buttons.map(button => button.getAttribute('aria-label') ?? ''));
  const shown = buttons.length === 0 ? 'hidden' : buttons[0].disabled ? `disabled: ${buttons[0].getAttribute('aria-label')}` : buttons[0].textContent;
  mounted.unmount();
  return shown;
}

const unknownReason = 'Voice availability is unknown, try again.';
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

for (const interaction of ['hover', 'focus', 'tap'] as const) {
  test(`disabled call reason is visible on ${interaction}`, async () => {
    const reason = 'Voice calls work in sessions started from Code. This session was started in Herdr.';
    advertised.set('/reason', { available: false, reason });
    const { container, happy } = await mount('/reason');
    if (process.env.OC125_DOM_EVIDENCE) console.log('DOM before interaction:', container.innerHTML);
    const trigger = happy.document.querySelector('span');
    expect(trigger).not.toBeNull();
    await act(async () => {
      if (interaction === 'hover') trigger?.dispatchEvent(new happy.MouseEvent('mouseover', { bubbles: true }));
      if (interaction === 'focus') trigger?.focus();
      if (interaction === 'tap') {
        trigger?.dispatchEvent(new happy.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        trigger?.dispatchEvent(new happy.PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
        trigger?.click();
      }
      await settle();
    });
    const tooltip = document.querySelector('[data-slot="tooltip-content"]');
    expect(tooltip?.textContent).toBe(reason);
    expect(container.querySelector('button')?.disabled).toBe(true);
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(`Voice call. ${reason}`);
    if (process.env.OC125_DOM_EVIDENCE) console.log(`DOM ${interaction}:`, document.body.innerHTML);
  });

  test(`unknown availability followed by available on ${interaction} enables the call`, async () => {
    advertised.set('/retry', { available: false, reason: unknownReason });
    const { container, happy } = await mount('/retry');
    asked.length = 0;
    advertised.set('/retry', { available: true });
    const trigger = happy.document.querySelector('span');
    expect(trigger).not.toBeNull();
    await act(async () => {
      if (interaction === 'hover') trigger?.dispatchEvent(new happy.MouseEvent('mouseover', { bubbles: true }));
      if (interaction === 'focus') trigger?.focus();
      if (interaction === 'tap') trigger?.click();
      await settle();
    });
    expect(asked).toEqual(['s1@/retry']);
    expect(container.querySelector('button')?.disabled).toBe(false);
  });
}

test('unknown availability automatically recovers after the first bounded retry', async () => {
  advertised.set('/auto', { available: false, reason: unknownReason });
  const { container } = await mount('/auto');
  asked.length = 0;
  advertised.set('/auto', { available: true });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  expect(asked).toEqual(['s1@/auto']);
  expect(container.querySelector('button')?.disabled).toBe(false);
});

test('automatic unknown retries stop after 2 s, 5 s and 10 s; interaction still retries', async () => {
  advertised.set('/bounded', { available: false, reason: unknownReason });
  const { container } = await mount('/bounded');
  asked.length = 0;
  for (const [delay, count] of [[2100, 1], [5100, 2], [10100, 3], [2100, 3]]) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, delay)); });
    expect(asked.length).toBe(count);
  }
  advertised.set('/bounded', { available: true });
  await act(async () => { container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')?.click(); await settle(); });
  expect(asked.length).toBe(4);
  expect(container.querySelector('button')?.disabled).toBe(false);
}, 25000);

test('unmount cancels unknown retries', async () => {
  advertised.set('/unmount', { available: false, reason: unknownReason });
  const { unmount } = await mount('/unmount');
  asked.length = 0;
  unmount();
  await new Promise(resolve => setTimeout(resolve, 2100));
  expect(asked).toEqual([]);
});

test('an in-flight unknown probe completing after unmount cannot schedule another retry', async () => {
  advertised.set('/late', { available: false, reason: unknownReason });
  const { container, unmount } = await mount('/late');
  let complete: (voice: Voice) => void = () => {};
  pending.set('/late', new Promise(resolve => { complete = resolve; }));
  asked.length = 0;
  await act(async () => { container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')?.click(); await settle(); });
  expect(asked).toEqual(['s1@/late']);
  unmount();
  complete({ available: false, reason: unknownReason });
  await new Promise(resolve => setTimeout(resolve, 2100));
  expect(asked).toEqual(['s1@/late']);
});

test('a definitive no has no automatic retries; a failed interaction preserves its visible reason', async () => {
  const reason = 'This session was started in Herdr.';
  advertised.set('/known-no', { available: false, reason });
  const { container, happy } = await mount('/known-no');
  asked.length = 0;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  expect(asked).toEqual([]);
  advertised.delete('/known-no');
  await act(async () => {
    const trigger = happy.document.querySelector('span');
    trigger?.dispatchEvent(new happy.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    trigger?.dispatchEvent(new happy.PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    trigger?.click();
    await settle();
  });
  expect(asked).toEqual(['s1@/known-no']);
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(reason);
});

test('a session change cancels the old retry', async () => {
  advertised.set('/old', { available: false, reason: unknownReason });
  advertised.set('/new', { available: true });
  const { container, changeSession } = await mount('/old');
  asked.length = 0;
  await changeSession('s2', '/new');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  expect(asked).toEqual(['s2@/new']);
  expect(container.querySelector('button')?.disabled).toBe(false);
});

test('overlapping interactions share one probe, and a stale result cannot affect another session', async () => {
  advertised.set('/pending', { available: false, reason: unknownReason });
  advertised.set('/new', { available: true });
  const { container, happy, changeSession } = await mount('/pending');
  let complete: (voice: Voice) => void = () => {};
  pending.set('/pending', new Promise(resolve => { complete = resolve; }));
  asked.length = 0;
  await act(async () => {
    const trigger = happy.document.querySelector('span');
    trigger?.dispatchEvent(new happy.MouseEvent('mouseover', { bubbles: true }));
    trigger?.focus();
    trigger?.click();
    await settle();
  });
  expect(asked).toEqual(['s1@/pending']);
  await changeSession('s2', '/new');
  await act(async () => { complete({ available: false, reason: unknownReason }); await settle(); });
  expect(container.querySelector('button')?.disabled).toBe(false);
});

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
  createWindow();
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
