import { expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { deferred } from '@/sync/native-draft-fixture';
import { NATIVE_CREATION_INVALIDATED } from '@/lib/opencode/nativeCreation';
import { abandonedNativeCreations } from '@/sync/native-draft-control';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { directoryB, mountedStart523 } from './startRelease523.fixture';

for (const outcome of ['409', 'cancelled'] as const) {
  test(`old A ${outcome} Stop settlement cannot overwrite B's newer pending control`, async () => {
    const c = await mountedStart523('create', -1);
    const responseA = deferred<Response>(), responseB = deferred<Response>();
    let originalA: ReturnType<typeof c.server.operation> | undefined;
    c.server.respondToStop(cancelled => {
      if (cancelled.directory === directoryB) {
        Object.assign(cancelled, c.server.held[1].operation);
        return responseB.promise;
      }
      if (outcome === '409' && originalA) Object.assign(cancelled, originalA);
      return responseA.promise;
    });
    const bStop = () => c.dom.container.querySelector<HTMLButtonElement>(`button[data-operation-id="${c.server.held[1].operation.operationId}"]`);
    try {
      await c.replace('held A'); await c.submit(); await c.server.entered; await c.refresh();
      originalA = { ...c.server.operation() }; await c.clickStop();
      c.server.state.holdMore = true;
      await c.navigate('b'); await c.replace('held B'); await c.submit();
      await act(async () => {
        window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED, { detail: { runtimeKey: c.runtimeA, directory: directoryB } }));
        await sleep(10);
      });
      expect(c.server.held).toHaveLength(2);
      expect(bStop()).not.toBeNull();
      await act(async () => { bStop()?.click(); await sleep(20); });
      expect(bStop()?.disabled).toBe(true);
      await c.navigate('a');
      await act(async () => {
        responseA.resolve(outcome === '409'
          ? Response.json({ name: 'APIError', data: { message: 'Old A refused Stop', isRetryable: false } }, { status: 409 })
          : Response.json({ nativeCreation: c.server.operation() }));
        await sleep(30);
      });
      await c.navigate('b'); await c.refresh();
      expect(c.text()).toBe('held B'); expect(c.starting()).toBe(true);
      expect(bStop()?.disabled).toBe(true);
      expect(c.dom.container.textContent).not.toContain('Old A refused Stop');
      expect(c.creates()).toHaveLength(2); expect(c.server.state.abandons).toHaveLength(2); expect(c.prompts()).toHaveLength(0);
      expect(c.server.held.every(gate => !gate.released)).toBe(true);
      await act(async () => { responseB.resolve(Response.json({ nativeCreation: { phase: 'cancelled' } })); await sleep(30); });
      expect(bStop()?.disabled).toBe(false); expect(c.starting()).toBe(true);
      expect(c.dom.container.textContent).toContain(nativeCreationI18n.en['chat.nativeCreation.unknown']);
      expect(abandonedNativeCreations.has(c.server.held[1].operation.operationId)).toBe(false);
    } finally {
      responseA.resolve(Response.json({ nativeCreation: c.server.operation() }));
      responseB.resolve(Response.json({ nativeCreation: { phase: 'cancelled' } }));
      await c.dispose();
    }
  });
}

for (const replacement of ['same-key', 'different-key'] as const) {
  test(`late Stop on a retired ${replacement} runtime scope never presents its error on the replacement`, async () => {
    const c = await mountedStart523('create', -1);
    const response = deferred<Response>();
    c.server.respondToStop(() => response.promise);
    try {
      await c.replace('original A'); await c.submit(); await c.server.entered; await c.refresh();
      const operation = { ...c.server.operation() }, scope = captureRuntimeRequestScope();
      await c.clickStop();
      await act(async () => { c.switchRuntime(replacement === 'same-key' ? c.runtimeA : 'late-stop-523-replacement'); await sleep(10); });
      await c.navigate('a'); await c.replace('replacement A');
      const shown = useSessionUIStore.getState().newSessionDraft;
      expect(isRuntimeRequestScopeCurrent(scope)).toBe(false);
      await act(async () => {
        response.resolve(Response.json({ name: 'APIError', data: { message: 'Retired origin Stop error', isRetryable: false } }, { status: 409 }));
        await sleep(30);
      });
      await c.refresh();
      expect(c.text()).toBe('replacement A'); expect(useSessionUIStore.getState().newSessionDraft).toBe(shown);
      expect(c.dom.container.textContent).not.toContain('Retired origin Stop error');
      expect(c.dom.container.textContent).not.toContain(nativeCreationI18n.en['chat.nativeCreation.stale']);
      expect(abandonedNativeCreations.has(operation.operationId)).toBe(false);
      expect(c.creates()).toHaveLength(1); expect(c.server.state.abandons).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
      expect(c.server.held[0].released).toBe(false);
    } finally {
      response.resolve(Response.json({ nativeCreation: c.server.operation() }));
      await c.dispose();
    }
  });
}
