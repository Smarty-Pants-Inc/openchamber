import { expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { deferred, directory as A, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useInputStore } from '@/sync/input-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { sendAdmission } from '@/sync/send-admission';
const sessionSendState = { isPending: (runtimeKey: string, sessionId: string) => sendAdmission.unconfirmed(runtimeKey, sessionId) !== undefined };
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { sendUnconfirmed } from '@/lib/sendUnconfirmed';

// smarty-code#1427, from the independent audit's R4C-SYNC-OWNED-BOOTSTRAP-ADMISSION-01 probe. The global
// listing knows the ordinary owner and the loader accepted its history before the directory row exists.
// That first Send must reserve the session. The first response stays held until after the safety checks.
const row = { ...session, nativeRuntime: 'ordinary', herdrState: 'idle', herdrPaneLive: true,
  ordinary: { generation: 'audit-known-native', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' } };

for (const [label, status] of [['accepted', 204], ['refused', 409]] as const) {
  test(`global-only ordinary owner reserves before directory bootstrap and across remount, then releases when ${label}`, async () => {
    const c = await mountedNativeComposer(false, undefined, undefined, undefined, f => {
      useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedRows: [{ id: 'a', worktree: A }], managedProjects: [{ id: 'a', path: A, addedAt: 0, lastOpenedAt: 0 }] });
      f.children.ensureChild(A, { bootstrap: false }).setState({ session: [] });
      useGlobalSessionsStore.getState().applySnapshot([row], []);
      useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, selectedManagedOwner: null, newSessionDraft: { ...state.newSessionDraft, open: false } }));
      useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
    });
    const response = deferred<Response>(), originalDelay = sendUnconfirmed.ms;
    let firstKnown = false, posts = 0, settled = false;
    void response.promise.then(() => { firstKnown = true; });
    c.handlers.prompt = async () => ++posts === 1 ? response.promise : new Response(null, { status: 204 });
    sendUnconfirmed.ms = 250;
    try {
      await c.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
      expect(readOrdinaryModel(useGlobalSessionsStore.getState().entityById.get(session.id))?.model).toBeDefined();
      expect(c.loader.getSendableOrdinaryView({ directory: A, sessionID: session.id }, c.runtimeA)).toBeDefined();
      await c.replace('Known ordinary owner before child bootstrap'); await c.submit();
      expect(c.prompts()).toHaveLength(1);
      expect(c.prompts()[0].headers.get('x-smarty-ordinary-view')).not.toBeNull();
      expect(sessionSendState.isPending(c.runtimeA, session.id)).toBe(true);
      // Past the watchdog, then the directory row arrives and the composer is replaced.
      await act(async () => { await sleep(300); });
      await act(async () => { c.children.getChild(A)!.setState({ session: [row] }); c.remount(); });
      await c.replace('Unrelated Send after ordinary child bootstrap and remount'); await c.submit();
      await act(async () => { await sleep(30); });
      expect(firstKnown).toBe(false);
      expect(c.prompts()).toHaveLength(1);
      expect(sessionSendState.isPending(c.runtimeA, session.id)).toBe(true);

      await act(async () => { response.resolve(new Response(null, { status })); await sleep(30); });
      settled = true;
      expect(sessionSendState.isPending(c.runtimeA, session.id)).toBe(false);
      expect(c.prompts()).toHaveLength(1); // Release sends nothing by itself.
      await c.replace('Deliberate Send after a known outcome'); await c.submit();
      await act(async () => { await sleep(30); });
      expect(c.prompts()).toHaveLength(2);
      const [first, second] = await Promise.all(c.prompts().map(request => request.clone().json()));
      expect(second.messageID).not.toBe(first.messageID);
    } finally {
      if (!settled) await act(async () => { response.resolve(new Response(null, { status: 409 })); await sleep(30); });
      sendUnconfirmed.ms = originalDelay; await c.dispose();
    }
  });
}
