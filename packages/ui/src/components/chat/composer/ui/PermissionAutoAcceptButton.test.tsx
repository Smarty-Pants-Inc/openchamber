import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer, errors, btwPanelSpy } from '../submit/__tests__/nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { usePermissionStore } from '@/stores/permissionStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useBtwStore } from '@/stores/useBtwStore';
import { ShortcutDispatcher, shortcutRegistry, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { respondToPermission } from '@/sync/session-actions';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
const originalBtw = useBtwStore.getState();
const originalPolicy = usePermissionStore.getState();
afterEach(async () => {
  await mounted?.dispose(); mounted = undefined;
  useBtwStore.setState(originalBtw, true);
  usePermissionStore.setState(originalPolicy, true);
});

for (const mode of ['draft', 'session', 'btw'] as const) {
  test(`actual mounted ${mode} permission toggle and shortcut report unavailable without mutations or requests`, async () => {
    if (mode === 'btw') btwPanelSpy.mockRestore();
    const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, (fixture) => {
      usePermissionStore.setState({ autoAccept: { [session.id]: true }, legacyCandidate: { [session.id]: true } });
      useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, permissionAutoAcceptEnabled: true } }));
      if (mode !== 'draft') {
        fixture.children.ensureChild(directory, { bootstrap: false }).setState({ session: [session] });
        useSessionUIStore.setState(state => ({
          currentSessionId: session.id, currentSessionDirectory: directory,
          newSessionDraft: { ...state.newSessionDraft, open: false },
        }));
      }
      if (mode === 'btw') useBtwStore.getState().setPanelState(session.id, { pending: true, collapsed: false, pendingAutoAccept: true });
    });
    await act(async () => { await sleep(0); });
    const footer = c.dom.container.querySelector('[data-chat-input-footer="true"]');
    expect(footer).not.toBeNull();
    // Locate the actual footer control; stored enabled state must not make
    // either its visual state or its action authoritative.
    const icon = footer?.querySelector('svg use[href*="shield-"]');
    const button = icon?.closest('button');
    if (!button) throw new Error('Actual mounted permission toggle missing');
    const draft = useSessionUIStore.getState().newSessionDraft;
    const btw = useBtwStore.getState().byParent;
    const policy = usePermissionStore.getState().autoAccept;
    const requestCount = c.requests.length;
    const dispatcher = new ShortcutDispatcher({ registry: shortcutRegistry, getBinding: action => getEffectiveShortcutCombo(action, {}) });
    await act(async () => {
      button.click();
      expect(dispatcher.dispatch(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))).toBe(true);
      expect(dispatcher.dispatch(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true);
      await sleep(0);
    });
    expect(errors).toEqual(['Unavailable', 'Unavailable']);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Unavailable');
    expect(useSessionUIStore.getState().newSessionDraft).toBe(draft);
    expect(useBtwStore.getState().byParent).toBe(btw);
    expect(usePermissionStore.getState().autoAccept).toBe(policy);
    expect(c.requests).toHaveLength(requestCount);
  });
}

test('manual production permission reply still uses the scoped SDK after mounted auto-accept refusal', async () => {
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => {
    fixture.children.ensureChild(directory, { bootstrap: false }).setState({ session: [session] });
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: directory,
      newSessionDraft: { ...state.newSessionDraft, open: false } }));
  });
  const fixtureFetch = globalThis.fetch;
  const replies: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.includes('/permission/')) {
      replies.push(request.clone());
      return Response.json(true);
    }
    return fixtureFetch(input, init);
  };
  try {
    const button = c.dom.container.querySelector('svg use[href*="shield-"]')?.closest('button');
    if (!button) throw new Error('Actual permission control missing');
    await act(async () => { button.click(); await sleep(0); });
    expect(errors).toEqual(['Unavailable']);
    expect(replies).toHaveLength(0);
    await respondToPermission(session.id, 'manual', 'once', directory);
    expect(replies).toHaveLength(1);
    expect(replies[0].method).toBe('POST');
    expect(new URL(replies[0].url).pathname).toBe('/api/permission/manual/reply');
    expect(new URL(replies[0].url).searchParams.get('directory')).toBe(directory);
    expect(await replies[0].json()).toEqual({ reply: 'once' });
  } finally { globalThis.fetch = fixtureFetch; }
});
