import React, { act } from 'react';
import { afterAll, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';

// smarty-code#126, OC#188 review: the mobile Voice call control mounts and unmounts as the composer collapses to the
// pill and as sessions change. The call belongs to the page-level store (OC#168), so neither may end or misstate it.
const ordinary = { generation: 'g', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' };
const row = (id: string) => ({ id, slug: id, projectID: 'p', title: id, version: '1', time: { created: 1, updated: 1 }, directory: '/project', ordinary });
mock.module('@/sync/sync-context', () => ({ useSession: (id: string) => row(id) }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: (pick: (state: unknown) => unknown) =>
  pick({ getDirectoryForSession: () => '/project' }) }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: { sessionVoiceAvailability: async () => ({ available: true }) } }));
mock.module('@/lib/voice/piVoiceMedia', () => ({ supportsPiVoice: () => true, browserPiVoiceMedia: () => { throw new Error('not in this test'); } }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));

const happy = new Window({ url: 'https://code.example.test' });
const values = { window: happy, document: happy.document, navigator: happy.navigator, Node: happy.Node,
  Element: happy.Element, HTMLElement: happy.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
afterAll(async () => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await happy.happyDOM.close();
});

const { SessionVoiceCall } = await import('./SessionVoiceCall');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
const { getActivePiVoiceCall, startPiVoiceCallFor, endActivePiVoiceCall } = await import('@/lib/voice/piVoiceActiveCall');
const { fakePiVoiceDriver } = await import('@/lib/voice/piVoiceTestDriver');
const { getRuntimeKey } = await import('@/lib/runtime-switch');

const container = happy.document.createElement('div') as unknown as HTMLElement;
happy.document.body.appendChild(container as never);
const root = createRoot(container);
// SAFETY: PiVoiceControl reads only `runtime.isVSCode` from the runtime context.
const runtime = { runtime: { platform: 'web', isVSCode: false, isDesktop: false } } as RuntimeAPIs;
const show = (sessionId: string | null) => act(async () => {
  root.render(<I18nProvider><RuntimeAPIContext.Provider value={runtime}>
    {sessionId ? <SessionVoiceCall sessionId={sessionId} /> : null}
  </RuntimeAPIContext.Provider></I18nProvider>);
  await new Promise(resolve => setTimeout(resolve, 10));
});
const buttons = () => [...container.querySelectorAll('button')].map(button => button.textContent);

test('collapsing to the pill (unmount) keeps the call; a session switch shows Move call here, the own session no Start', async () => {
  const { driver, calls, runtime: fake } = fakePiVoiceDriver();
  fake.key = getRuntimeKey(); // the call is on this page's runtime
  await show('s1');
  expect(buttons()).toEqual(['Voice call']);
  await act(async () => { await startPiVoiceCallFor('s1', '/project', driver, { onEnded: () => {}, onFailed: () => {} }); });
  expect(getActivePiVoiceCall()?.sessionId).toBe('s1');
  expect(buttons()).toEqual([]); // the call's own session: End is in the shell call bar
  await show(null); // the composer collapses to the pill: the control unmounts
  expect(getActivePiVoiceCall()?.sessionId).toBe('s1'); expect(calls[0]!.hungUp).toBe(false);
  await show('s2'); // another session
  expect(buttons()).toEqual(['Move call here']);
  await show('s1'); // back to the call's session
  expect(buttons()).toEqual([]);
  expect(calls[0]!.hungUp).toBe(false);
  await act(async () => { endActivePiVoiceCall(); });
  expect(buttons()).toEqual(['Voice call']);
  await act(async () => root.unmount());
});
