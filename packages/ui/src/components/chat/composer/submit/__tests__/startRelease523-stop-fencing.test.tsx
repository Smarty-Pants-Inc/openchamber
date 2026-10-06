import { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startNativeDraft } from '@/sync/native-draft-start';
import { STOP_START_GRACE_MS } from '@/sync/native-draft-control';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { mountedStart523 } from './startRelease523.fixture';
import { deferred } from '@/sync/native-draft-fixture';
import { abandonedNativeCreations } from '@/sync/native-draft-control';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';

let mounted: Awaited<ReturnType<typeof mountedStart523>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

for (const receipt of ['cancelled', 'ready'] as const) test(`Stop allows newer A before old ${receipt} receipt and old finally cannot release it`, async () => {
  const c = mounted = await mountedStart523('trust');
  const now = Date.now; let clock = now(); Date.now = () => clock;
  let newer: Promise<void> | undefined;
  try {
    await c.replace('retained A'); await c.submit(); await c.server.entered;
    await c.refresh(); clock += STOP_START_GRACE_MS + 1; await c.refresh();
    await c.clickStop(); c.server.state.holdMore = true;
    await act(async () => { newer = startNativeDraft([]).catch(() => {}); await sleep(20); });
    console.log(`523 fencing receipt=${receipt} server=${c.server.operation().phase} creates=${c.creates().length} gates=${c.server.held.length} starting=${c.starting()}`);
    expect(c.creates()).toHaveLength(2); // RED: successful Stop has not released the original start.
    expect(c.server.held).toHaveLength(2);
    await act(async () => { c.server.release(0, receipt); await sleep(20); });
    expect(c.starting()).toBe(true); // Old finally must not clear the newer attempt's reservation.
    expect(c.server.held[1].released).toBe(false);
    expect(c.text()).toBe('retained A'); expect(c.prompts()).toHaveLength(0);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    await c.submit(); expect(c.creates()).toHaveLength(2); // Duplicate guard still owns newer A.
  } finally {
    Date.now = now;
    await act(async () => { c.server.release(1); await sleep(20); }); await newer;
  }
});

test('after old held request finishes, synthetic fixture admits one separate explicit Send without replay', async () => {
  const c = mounted = await mountedStart523('create');
  await c.replace('retained fixture control'); await c.submit(); await c.server.entered;
  await act(async () => { c.server.release(); await sleep(20); });
  expect(c.starting()).toBe(false); expect(c.text()).toBe('retained fixture control');
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  await c.submit(); await act(async () => { await sleep(20); });
  expect(c.creates()).toHaveLength(2); expect(c.prompts()).toHaveLength(1);
  expect(c.server.state.actions).toHaveLength(0);
});

for (const change of ['project', 'runtime'] as const) test(`late successful Stop after ${change} change cannot release the newer B attempt or report Stopped there`, async () => {
  const c = mounted = await mountedStart523('create', -1);
  const receipt = deferred<Response>(), entered = deferred<Response>();
  c.server.respondToStop(cancelled => { entered.resolve(Response.json({ nativeCreation: cancelled })); return receipt.promise; });
  try {
    await c.replace('old runtime text'); await c.submit(); await c.server.entered; await c.refresh();
    const operation = c.server.operation();
    await c.clickStop(); const stopped = await entered.promise;
    if (change === 'runtime') await act(async () => { c.switchRuntime('523-runtime-replacement'); await sleep(10); });
    c.server.state.holdMore = true;
    await c.navigate('b'); await c.replace('replacement runtime input'); await c.submit();
    expect(c.server.held).toHaveLength(2); expect(c.starting()).toBe(true);
    const shown = useSessionUIStore.getState().newSessionDraft;
    await act(async () => { receipt.resolve(stopped); await sleep(20); });
    expect(abandonedNativeCreations.has(operation.operationId)).toBe(change === 'project');
    expect(c.starting()).toBe(true); expect(c.text()).toBe('replacement runtime input');
    expect(useSessionUIStore.getState().newSessionDraft).toBe(shown);
    const alerts = [...c.dom.container.querySelectorAll('[role="alert"]')].map(node => node.textContent).join('\n');
    expect(alerts).not.toContain(nativeCreationI18n.en['chat.nativeCreation.stopped']);
    expect(alerts).not.toContain(nativeCreationI18n.en['chat.nativeCreation.unknown']);
    await act(async () => { c.server.release(0, 'ready'); await sleep(20); });
    expect(c.starting()).toBe(true); expect(c.prompts()).toHaveLength(0);
    await c.submit(); expect(c.creates()).toHaveLength(2);
  } finally { receipt.resolve(Response.json({ nativeCreation: c.server.operation() })); }
});
