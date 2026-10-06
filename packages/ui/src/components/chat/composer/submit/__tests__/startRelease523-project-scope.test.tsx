import { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startNativeDraft } from '@/sync/native-draft-start';
import { directory } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { mountedStart523, directoryB } from './startRelease523.fixture';

let mounted: Awaited<ReturnType<typeof mountedStart523>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

for (const mode of ['create', 'trust'] as const) test(`B can Send while A's actual ${mode} response is held`, async () => {
  const c = mounted = await mountedStart523(mode);
  await c.replace('held A'); await c.submit(); await c.server.entered;
  await c.navigate('b'); await c.replace('B message'); await c.submit();
  const bCreates = c.creates().filter(request => new URL(request.url).searchParams.get('directory') === directoryB);
  console.log(`523 projectB gate=${mode} starting=${c.starting()} falseStarting=${c.dom.container.textContent?.includes('Starting a new session')} createsB=${bCreates.length} prompts=${c.prompts().length}`);
  expect(bCreates).toHaveLength(1); // RED: startNativeDraft rejects with global 'sending'.
  expect(c.prompts()).toHaveLength(1);
  await c.navigate('a'); expect(c.text()).toBe('held A');
});

for (const phase of ['cancelled', 'ready'] as const) test(`late A ${phase} receipt cannot clear newer B reservation or consume B input`, async () => {
  const c = mounted = await mountedStart523('create');
  await c.replace('held A'); await c.submit(); await c.server.entered;
  c.server.state.holdMore = true;
  await c.navigate('b'); await c.replace('newer B');
  const newer = startNativeDraft([]).catch(error => error);
  try {
    await act(async () => { await sleep(20); });
    expect(c.creates()).toHaveLength(2); // RED prerequisite: unrelated B must actually own another held start.
    expect(c.server.held).toHaveLength(2);
    await act(async () => { c.server.release(0, phase); await sleep(20); });
    expect(c.starting()).toBe(true);
    expect(c.server.held[1].released).toBe(false);
    expect(c.text()).toBe('newer B'); expect(c.prompts()).toHaveLength(0);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    await c.submit(); expect(c.creates()).toHaveLength(2); // Same-project duplicate remains refused.
  } finally {
    await act(async () => { c.server.release(1); await sleep(20); }); await newer;
  }
});

for (const change of ['target', 'runtime'] as const) test(`late held create after ${change} change cannot select, send or replace shown draft`, async () => {
  const c = mounted = await mountedStart523('create');
  await c.replace('old A'); await c.submit(); await c.server.entered;
  if (change === 'target') await c.navigate('b');
  else await act(async () => { c.switchRuntime('523-runtime-b'); await sleep(10); });
  await c.replace('untouched target');
  const shown = useSessionUIStore.getState().newSessionDraft;
  await act(async () => { c.server.release(0, 'ready'); await sleep(20); });
  expect(c.text()).toBe('untouched target');
  expect(useSessionUIStore.getState().newSessionDraft).toBe(shown);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(c.server.state.actions).toHaveLength(0);
});

test('same project duplicate cannot dispatch a second create while original create is held', async () => {
  const c = mounted = await mountedStart523('create');
  await c.replace('duplicate guard'); await c.submit(); await c.server.entered;
  await c.submit();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(c.text()).toBe('duplicate guard');
  expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(directory);
});

test('a different New session draft in same project cannot create alongside the held start', async () => {
  const c = mounted = await mountedStart523('create');
  await c.replace('held original'); await c.submit(); await c.server.entered;
  const oldId = useSessionUIStore.getState().newSessionDraft.draftId;
  await act(async () => {
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'a', directoryOverride: directory });
    await sleep(10);
  });
  expect(useSessionUIStore.getState().newSessionDraft.draftId).not.toBe(oldId);
  await c.replace('different draft same project'); await c.submit();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(c.text()).toBe('different draft same project');
});
