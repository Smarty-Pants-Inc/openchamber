import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { nativeCreationForDraft } from '@/sync/native-draft-creation';
import { abandonedNativeCreations } from '@/sync/native-draft-control';
import { STOP_START_GRACE_MS } from '@/sync/native-draft-control';
import { mountedStart523 } from './startRelease523.fixture';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { sentStartRequest } from '@/sync/native-draft-sent';
import { directory } from '@/sync/native-draft-fixture';

let mounted: Awaited<ReturnType<typeof mountedStart523>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

for (const returned of [false, true]) test(`successful own Stop releases Start before held trust receipt, ${returned ? 'leave/return' : 'stay'}`, async () => {
  const c = mounted = await mountedStart523('trust');
  const now = Date.now; let clock = now(); Date.now = () => clock;
  try {
    await c.replace('own stuck start'); await c.submit(); await c.server.entered;
    await c.refresh(); clock += STOP_START_GRACE_MS + 1;
    if (returned) { await c.navigate('b'); await c.navigate('a'); }
    await c.refresh();
    expect(c.stop()).not.toBeNull(); expect(c.stop()?.disabled).toBe(false);
    await c.clickStop();
    expect(c.server.operation().phase).toBe('cancelled');
    expect(c.server.state.abandons).toEqual([c.server.operation().operationId]);
    expect(c.server.held[0].released).toBe(false); // Stop proof is before old response, never gate teardown.
    expect(c.text()).toBe('own stuck start'); expect(c.prompts()).toHaveLength(0);
    const ui = useSessionUIStore.getState(), record = nativeCreationForDraft(ui.nativeDraftCreations, ui.newSessionDraft, c.runtimeA);
    console.log(`523 ownStop return=${returned} server=${c.server.operation().phase} retained=${record?.status === 'pending' ? record.operation.phase : record?.status} busy=${record?.status === 'pending' && !!record.busy} starting=${c.starting()} oldHeld=${!c.server.held[0].released} creates=${c.creates().length} prompts=${c.prompts().length}`);
    expect(c.starting()).toBe(false); // The original RED could not settle the busy record or release Start.
    expect(sentStartRequest(c.runtimeA, directory)).toBeUndefined(); // Also when the live editor has not flushed storage yet.
    expect(c.editor().contentDOM.getAttribute('contenteditable')).toBe('true');
    await c.submit(); await act(async () => { await sleep(20); });
    expect(c.creates()).toHaveLength(2); expect(c.prompts()).toHaveLength(1);
    await c.refresh(); expect(c.server.state.actions).toEqual(['trust']);
  } finally { Date.now = now; }
});

test('definite Stop refusal leaves original held attempt, text and reservation intact without extra mutations', async () => {
  const c = mounted = await mountedStart523('trust');
  const now = Date.now; let clock = now(); Date.now = () => clock;
  try {
    await c.replace('refused text'); await c.submit(); await c.server.entered;
    await c.refresh(); clock += STOP_START_GRACE_MS + 1; await c.refresh();
    c.server.state.refuse = true;
    await c.clickStop();
    expect(c.dom.container.querySelector('[role="alert"]')?.textContent).toContain('This start already finished; nothing to abandon');
    expect(abandonedNativeCreations.has(c.server.operation().operationId)).toBe(false);
    expect(c.server.operation().phase).toBe('awaiting-trust'); expect(c.starting()).toBe(true);
    expect(c.text()).toBe('refused text'); expect(c.stop()?.disabled).toBe(false);
    await c.submit(); expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
    expect(c.server.state.actions).toEqual(['trust']); expect(c.server.state.abandons).toHaveLength(1);
  } finally { Date.now = now; }
});

for (const fault of ['directory', 'request', 'operation', 'ready', 'malformed', 'uncertain'] as const) {
  test(`${fault} Stop receipt retains the original reservation and editable text without claiming Stopped`, async () => {
    const c = mounted = await mountedStart523('create', -1);
    await c.replace('unsafe Stop keeps text'); await c.submit(); await c.server.entered;
    await c.refresh();
    c.server.respondToStop(cancelled => {
      if (fault === 'uncertain') return Response.json({ name: 'APIError', data: { message: 'Stop outcome is uncertain; check this start', isRetryable: false } }, { status: 503 });
      if (fault === 'malformed') return Response.json({ nativeCreation: { phase: 'cancelled' } });
      const next = fault === 'directory' ? { ...cancelled, directory: '/wrong-project' }
        : fault === 'request' ? { ...cancelled, clientRequestId: crypto.randomUUID() }
        : fault === 'operation' ? { ...cancelled, operationId: crypto.randomUUID() }
        : { ...cancelled, phase: 'ready' };
      return Response.json({ nativeCreation: next });
    });
    await c.clickStop();
    expect(c.starting()).toBe(true); expect(c.text()).toBe('unsafe Stop keeps text');
    expect(c.server.held[0].released).toBe(false);
    expect(abandonedNativeCreations.has(c.server.operation().operationId)).toBe(false);
    const alerts = [...c.dom.container.querySelectorAll('[role="alert"]')].map(node => node.textContent).join('\n');
    expect(alerts).toContain(fault === 'uncertain' ? 'Stop outcome is uncertain; check this start' : nativeCreationI18n.en['chat.nativeCreation.unknown']);
    expect(alerts).not.toContain(nativeCreationI18n.en['chat.nativeCreation.stopped']);
    await c.submit(); expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  });
}
