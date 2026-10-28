import '@/sync/native-test-network';
import React, { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';

// Real client, SDK, runtimeFetch and schema. Only browser APIs and HTTP are synthetic.
const NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const originalFetch = globalThis.fetch;
let mediaStarts = 0;
function createWindow() {
  const happy = new Window({ url: 'https://code.example.test' });
  Object.defineProperties(happy, {
    isSecureContext: { value: true },
    RTCPeerConnection: { value: class {} },
    AudioContext: { value: class { constructor() { mediaStarts++; throw new Error('A recheck must not start media'); } } },
  });
  Object.defineProperty(happy.navigator, 'mediaDevices', { value: {} });
  const values = { window: happy, document: happy.document, navigator: happy.navigator, Node: happy.Node,
    Element: happy.Element, HTMLElement: happy.HTMLElement, DocumentFragment: happy.DocumentFragment,
    Event: happy.Event, CustomEvent: happy.CustomEvent, MouseEvent: happy.MouseEvent, PointerEvent: happy.PointerEvent,
    getComputedStyle: happy.getComputedStyle.bind(happy), ResizeObserver: happy.ResizeObserver,
    requestAnimationFrame: happy.requestAnimationFrame.bind(happy), cancelAnimationFrame: happy.cancelAnimationFrame.bind(happy),
    IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  return happy;
}
// Base UI chooses layout effects on import. Keep the actual shared Tooltip and Button.
createWindow();
const { PiVoiceControl } = await import('./PiVoiceControl');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
const { opencodeClient } = await import('@/lib/opencode/client');
const { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { configureRuntimeUrlResolver } = await import('@/lib/runtime-url');
const { getActivePiVoiceCall } = await import('@/lib/voice/piVoiceActiveCall');
const originalRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
let cleanup = () => {};
afterEach(() => {
  cleanup(); cleanup = () => {};
  switchRuntimeEndpoint(originalRuntime);
  configureRuntimeUrlResolver(originalRuntime.apiBaseUrl ? { apiBaseUrl: originalRuntime.apiBaseUrl } : {});
  opencodeClient.reconnectToRuntimeBaseUrl();
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const directory = '/voice-client-test', sessionId = 'voice-client-session';
const unknown = { available: false, reason: 'Voice is not available in this session right now. Try again in a moment.', retry: true };
const answer = (body: { available: boolean; reason?: string; retry?: boolean }) => () => Response.json(body);
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
async function mount(readers: Array<() => Response | Promise<Response>>) {
  const happy = createWindow();
  let reads = 0, healthReads = 0;
  mediaStarts = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    expect(url.hostname).toBe('synthetic.invalid');
    if (url.pathname.endsWith('/global/health')) {
      expect(url.searchParams.get('directory')).toBe(directory);
      healthReads++;
      return Response.json({ healthy: true, capabilities: { sessionVoiceStatus: 1 } });
    }
    if (url.pathname.endsWith(`/session/${sessionId}/voice`)) {
      expect(request.method).toBe('GET');
      expect(url.searchParams.get('directory')).toBe(directory);
      const reader = readers[Math.min(reads++, readers.length - 1)];
      if (!reader) throw new Error('Missing synthetic status handler');
      return reader();
    }
    // No network or call mutations may escape the fixture.
    if (url.pathname.endsWith('/auth/url-token')) return new Response(null, { status: 404 });
    throw new Error(`Unexpected voice fixture request: ${request.method} ${url.pathname}`);
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `voice-client-${crypto.randomUUID()}` });
  opencodeClient.reconnectToRuntimeBaseUrl();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // SAFETY: this control reads only runtime.isVSCode from RuntimeAPIContext.
  const runtime = { runtime: { platform: 'web', isVSCode: false, isDesktop: false } } as RuntimeAPIs;
  const render = (id: string, dir: string) => root.render(<I18nProvider><RuntimeAPIContext.Provider value={runtime}><PiVoiceControl sessionId={id} directory={dir} /></RuntimeAPIContext.Provider></I18nProvider>);
  await act(async () => { render(sessionId, directory); await settle(); });
  cleanup = () => { act(() => root.unmount()); void happy.happyDOM.abort(); };
  return { container, happy, reads: () => reads, healthReads: () => healthReads,
    unmount: () => { cleanup(); cleanup = () => {}; },
    rerender: () => act(() => render(sessionId, directory)),
  };
}
const wait = async (ms: number) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); };
const expectReason = (container: HTMLElement, reason: string) => {
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(`Voice call. ${reason}`);
};
const expectNoCall = () => { expect(mediaStarts).toBe(0); expect(getActivePiVoiceCall()).toBeUndefined(); };

test('exact gateway unknown/retry:true becomes available through the real client, without an automatic call', async () => {
  const fixture = await mount([answer(unknown), answer({ available: true })]);
  expectReason(fixture.container, unknown.reason);
  await wait(2100);
  expect(fixture.reads()).toBe(2);
  expect(fixture.healthReads()).toBe(2);
  expect(fixture.container.querySelector('button')?.disabled).toBe(false);
  expectNoCall();
});

test('a failed initial status read stays hidden, then the bounded retry can enable Call', async () => {
  const fixture = await mount([() => Response.json({}, { status: 503 }), answer({ available: true })]);
  expect(fixture.reads()).toBe(1);
  expect(fixture.container.querySelector('button')).toBeNull();
  await wait(2100);
  expect(fixture.reads()).toBe(2);
  expect(fixture.container.querySelector('button')?.disabled).toBe(false);
  expectNoCall();
});

test('a definitive answer after unknown cancels automatic recovery', async () => {
  const negative = { available: false, reason: 'This session was started in Herdr.' };
  const fixture = await mount([answer(unknown), answer(negative)]);
  await wait(2100);
  expect(fixture.reads()).toBe(2);
  expectReason(fixture.container, negative.reason);
  await wait(5100);
  expect(fixture.reads()).toBe(2);
  expectNoCall();
}, 10000);

test('retry:true works without English unknown/try-again text; no-hint gateways retain legacy retries', async () => {
  for (const negative of [{ available: false, reason: 'Probe pending.', retry: true }, { available: false, reason: 'Voice availability is unknown.' }]) {
    const fixture = await mount([answer(negative), answer({ available: true })]);
    expectReason(fixture.container, negative.reason);
    await wait(2100);
    expect(fixture.reads()).toBe(2);
    expect(fixture.container.querySelector('button')?.disabled).toBe(false);
    expectNoCall();
    fixture.unmount();
  }
});

for (const failure of ['HTTP 503', 'network'] as const) {
  test(`successful health plus ${failure} status failure retains the reason and the next bounded retry`, async () => {
    const fail = () => {
      if (failure === 'network') throw new Error('Synthetic voice status network failure');
      return Response.json({ message: 'Status unavailable' }, { status: 503 });
    };
    const fixture = await mount([answer({ available: false, reason: unknown.reason }), fail, answer({ available: true })]);
    expectReason(fixture.container, unknown.reason);
    await wait(2100);
    expect(fixture.reads()).toBe(2);
    expect(fixture.healthReads()).toBe(2);
    expectReason(fixture.container, unknown.reason);
    await wait(5100);
    expect(fixture.reads()).toBe(3);
    expect(fixture.healthReads()).toBe(3);
    expect(fixture.container.querySelector('button')?.disabled).toBe(false);
    expectNoCall();
  }, 10000);
}

test('status failures spend only the remaining retry budget; an interaction can recover after it is exhausted', async () => {
  const fixture = await mount([answer({ available: false, reason: unknown.reason }),
    () => Response.json({}, { status: 503 }),
    () => { throw new Error('Synthetic voice status network failure'); },
    () => Response.json({}, { status: 503 }), answer({ available: true })]);
  for (const [delay, count] of [[2100, 2], [5100, 3], [10100, 4], [2100, 4]]) {
    await wait(delay);
    expect(fixture.reads()).toBe(count);
    expectReason(fixture.container, unknown.reason);
  }
  await act(async () => { fixture.container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')?.click(); await settle(); });
  expect(fixture.reads()).toBe(5);
  expect(fixture.container.querySelector('button')?.disabled).toBe(false);
  expectNoCall();
}, 25000);

for (const negative of [
  { available: false, reason: 'This session was started in Herdr.' },
  { available: false, reason: 'Unknown session; try again elsewhere.', retry: false },
]) {
  test(`definitive negative does not poll, even after a failed interaction: ${negative.reason}`, async () => {
    const fixture = await mount([answer(negative), () => Response.json({}, { status: 503 })]);
    expectReason(fixture.container, negative.reason);
    await wait(2100);
    expect(fixture.reads()).toBe(1);
    await act(async () => {
      const trigger = fixture.happy.document.querySelector('span');
      trigger?.dispatchEvent(new fixture.happy.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      trigger?.dispatchEvent(new fixture.happy.PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      trigger?.click(); await settle();
    });
    expect(fixture.reads()).toBe(2);
    expectReason(fixture.container, negative.reason);
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(negative.reason);
    await wait(2100);
    expect(fixture.reads()).toBe(2);
    expectNoCall();
  }, 10000);
}

test('overlapping disabled-chip interactions share the actual pending status read', async () => {
  let complete: (response: Response) => void = () => {};
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  const fixture = await mount([answer(unknown), () => pending]);
  await act(async () => {
    const trigger = fixture.happy.document.querySelector('span');
    trigger?.dispatchEvent(new fixture.happy.MouseEvent('mouseover', { bubbles: true }));
    trigger?.focus(); trigger?.click(); await settle();
  });
  expect(fixture.reads()).toBe(2);
  await act(async () => { complete(Response.json({ available: true })); await settle(); });
  expect(fixture.container.querySelector('button')?.disabled).toBe(false);
  expectNoCall();
});

test('a pending status completion from another runtime cannot disable Call or schedule retries', async () => {
  let complete: (response: Response) => void = () => {};
  const fixture = await mount([answer(unknown), () => new Promise(resolve => { complete = resolve; }), answer({ available: true })]);
  await act(async () => { fixture.container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')?.click(); await settle(); });
  expect(fixture.reads()).toBe(2);
  await act(async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: 'voice-client-replacement' });
    opencodeClient.reconnectToRuntimeBaseUrl();
    fixture.rerender(); await settle();
  });
  expect(fixture.reads()).toBe(3);
  expect(fixture.container.querySelector('button')?.disabled).toBe(false);
  await act(async () => { complete(Response.json(unknown)); await settle(); });
  await wait(2100);
  expect(fixture.reads()).toBe(3);
  expect(fixture.container.querySelector('button')?.disabled).toBe(false);
  expectNoCall();
});

test('unmount drops a pending real-client unknown answer without scheduling more reads', async () => {
  let complete: (response: Response) => void = () => {};
  const fixture = await mount([answer(unknown), () => new Promise(resolve => { complete = resolve; })]);
  await act(async () => { fixture.container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')?.click(); await settle(); });
  expect(fixture.reads()).toBe(2);
  fixture.unmount();
  complete(Response.json(unknown));
  await wait(2100);
  expect(fixture.reads()).toBe(2);
  expectNoCall();
});

test('Call, enabled or disabled with its reason, is a 44 px touch target on a phone (smarty-code#1192)', async () => {
  const enabled = await mount([answer({ available: true })]);
  expect(enabled.container.querySelector('button')?.classList.contains('oc-touch-target')).toBe(true);
  enabled.unmount();
  const disabled = await mount([answer({ available: false, reason: 'No engine.' })]);
  expect(disabled.container.querySelector('button')?.classList.contains('oc-touch-target')).toBe(true);
  expectNoCall();
});
